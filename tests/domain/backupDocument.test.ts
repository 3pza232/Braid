import { describe, expect, it } from 'vitest';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  parseBackupDocument,
  remapBackup,
  type BackupDocument,
} from '@domain/rules/backupDocument';
import { createEmptyConversation } from '@domain/entities/conversation';
import { makeAvatar } from '@domain/value-objects/avatar';
import { asConversationId, asMessageId, asRoleId } from '@shared/ids';
import { node } from '../helpers/messageNode';

/**
 * 备份文档的解析与导入重映射
 *
 * 这段逻辑守的是**用户数据的唯一退路**，两条底线：
 *  1. 认不出来的文件必须整体拒绝，不能"猜着导入一半"；
 *  2. 导入必须给全部 id 重新发号 —— 原样导入会与库里已有记录撞车，
 *     而这些写操作都是 upsert，等于把现有对话覆盖掉。
 */

/** 确定性发号器：领域层不引入随机数，测试里才能断言具体 id */
function counter(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

function makeDocument(): BackupDocument {
  const role = {
    id: asRoleId('role-old'),
    name: '测试角色',
    avatar: makeAvatar(),
    description: '',
    tags: [],
    assistantName: null,
    userName: null,
    systemPrompt: '你好',
    greeting: '',
    modelProfileId: null,
    model: null,
    params: {},
    writingMode: null,
    variables: {},
    builtin: false,
    createdAt: 1,
    updatedAt: 1,
    extensions: {},
    schemaVersion: 1,
  } as unknown as BackupDocument['roles'][number];

  const conversation = createEmptyConversation(asConversationId('conv-old'), 100, {
    roleId: asRoleId('role-old'),
    roleInstance: {
      roleId: asRoleId('role-old'),
      name: '测试角色',
      avatar: makeAvatar(),
      assistantName: null,
      userName: null,
      systemPrompt: '你好',
      greeting: '',
      modelProfileId: null,
      model: null,
      params: {},
      writingMode: null,
      variables: {},
      capturedAt: 100,
    },
    // 虚拟根选中的是**第一条提问**，不是回答
    activeRootChildId: asMessageId('m1'),
  });

  // 一条用户消息 + 一条回答，构成最小但完整的树
  const first = node('m1', {
    conversationId: 'conv-old',
    role: 'user',
    segments: [{ kind: 'text', text: '你好' }],
    variantOf: asMessageId('m1'),
    activeChildId: asMessageId('m2'),
  });
  const second = node('m2', {
    conversationId: 'conv-old',
    parentId: asMessageId('m1'),
    variantOf: asMessageId('m2'),
  });

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: 5,
    conversations: [conversation],
    messages: [first, second],
    roles: [role],
  };
}

describe('parseBackupDocument', () => {
  it('拒绝不是备份的 JSON，并说清原因', () => {
    const result = parseBackupDocument({ hello: 'world' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Braid');
  });

  it('拒绝比当前程序更新的版本（老程序读新格式必然丢东西）', () => {
    const result = parseBackupDocument({ kind: BACKUP_KIND, version: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('升级');
  });

  it('个别条目结构坏了就丢掉并计数，不让它拖垮整份备份', () => {
    const result = parseBackupDocument({
      kind: BACKUP_KIND,
      version: 1,
      conversations: [makeDocument().conversations[0], { 坏数据: true }],
      messages: [makeDocument().messages[0], 42],
      roles: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.document.conversations).toHaveLength(1);
      expect(result.data.document.messages).toHaveLength(1);
      // 丢了两条就必须报两条 —— 静默丢数据是备份功能最不可原谅的失败
      expect(result.data.skipped).toBe(2);
    }
  });

  it('字段缺失时整体为空，但仍算解析成功', () => {
    const result = parseBackupDocument({ kind: BACKUP_KIND, version: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.document.conversations).toEqual([]);
      expect(result.data.skipped).toBe(0);
    }
  });
});

describe('remapBackup', () => {
  const run = () => {
    let index = 0;
    return remapBackup(makeDocument(), (prefix) => counter(prefix, (index += 1)), 999);
  };

  it('所有 id 都换新的 —— 导入是追加，不会覆盖库里已有记录', () => {
    const result = run();

    expect(result.document.conversations[0].id).not.toBe('conv-old');
    expect(result.document.roles[0].id).not.toBe('role-old');
    expect(result.document.messages.map((item) => item.id)).not.toContain(asMessageId('m1'));
  });

  it('树结构跟着一起改：parentId / activeChildId / variantOf 都指向新 id', () => {
    const result = run();
    const [first, second] = result.document.messages;

    expect(second.parentId).toBe(first.id);
    expect(first.activeChildId).toBe(second.id);
    expect(second.variantOf).toBe(second.id);
    // 会话上的"根分支指针"指的是消息，也必须换
    expect(result.document.conversations[0].activeRootChildId).toBe(first.id);
  });

  it('消息与角色实例的引用都指向新 id（否则树会散架、角色会失联）', () => {
    const result = run();
    const [conversation] = result.document.conversations;

    expect(result.document.messages[0].conversationId).toBe(conversation.id);
    expect(conversation.roleId).toBe(result.document.roles[0].id);
    expect(conversation.roleInstance?.roleId).toBe(result.document.roles[0].id);
  });

  it('所属会话不在备份里的消息被丢弃并计数', () => {
    const document = makeDocument();
    document.messages.push(
      node('orphan', { conversationId: 'conv-missing', segments: [{ kind: 'text', text: '孤儿' }] }),
    );

    let index = 0;
    const result = remapBackup(document, (prefix) => counter(prefix, (index += 1)), 999);

    expect(result.droppedMessages).toBe(1);
    expect(result.messageCount).toBe(2);
  });

  it('统计口径与实际写入条数一致（界面直接显示这几个数）', () => {
    const result = run();
    expect(result.conversationCount).toBe(result.document.conversations.length);
    expect(result.messageCount).toBe(result.document.messages.length);
    expect(result.roleCount).toBe(result.document.roles.length);
  });

  it('不修改入参（导出后再导入不该动到内存里那份）', () => {
    const document = makeDocument();
    const before = JSON.stringify(document);
    remapBackup(document, (prefix) => `${prefix}-x`, 999);
    expect(JSON.stringify(document)).toBe(before);
  });
});
