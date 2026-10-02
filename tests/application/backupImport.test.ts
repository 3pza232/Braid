import { describe, expect, it } from 'vitest';
import { createBackupService } from '@app/backup/BackupService';
import { createEmptyConversation } from '@domain/entities/conversation';
import type { RoleApi } from '@ports/RoleApi';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import { asConversationId } from '@shared/ids';
import { appError, err, ok } from '@shared/result';
import { createStores } from '../helpers/chatHarness';
import { node } from '../helpers/messageNode';

/**
 * 备份导入：**失败时必须说清楚已经写进去多少**
 *
 * 导入跨了三个仓储（角色 / 会话 / 消息），而底层的原子性原语
 * （`SqlPort.batch`）只能覆盖单个仓储 —— 所以"全成或全不成"在这里做不到。
 * 做不到就不要装作做到了：直接返回原始错误的话，用户会以为"导入失败 = 什么都没变"，
 * 于是再导一次，库里就出现两份。
 *
 * 用例走的是一条**真实往返**：先用导出器生成备份文件，再把它导入另一个库 ——
 * 这样"导出的形状"与"导入的解析"必须自洽，假数据编不出这种一致性。
 */

/** 只实现备份用到的两个方法（list 在导出里是同步调用） */
function createFakeRoles(): RoleApi {
  return {
    list: () => [],
    upsert: async (role: { id: string }) => ok(role),
  } as unknown as RoleApi;
}

/** 第 N 次保存开始失败（N 从 1 数） */
function createFailAfter(inner: ConversationStore, failAtCall: number) {
  let calls = 0;
  const store: ConversationStore = {
    list: () => inner.list(),
    save: async (conversation) => {
      calls += 1;
      if (calls >= failAtCall) return err(appError('VALIDATION_ERROR', '磁盘满了（测试注入）'));
      return inner.save(conversation);
    },
    saveMany: (items) => inner.saveMany(items),
    remove: (id, now) => inner.remove(id, now),
  };
  return { store, calls: () => calls };
}

async function buildBackupJson(): Promise<string> {
  const source = createStores();
  const now = 1_700_000_000_000;
  const first = createEmptyConversation(asConversationId('conv-a'), now, { title: '会话 A' });
  const second = createEmptyConversation(asConversationId('conv-b'), now, { title: '会话 B' });
  await source.store.save(first);
  await source.store.save(second);

  const message = node('msg-a1', { conversationId: 'conv-a', segments: [{ kind: 'text', text: '你好' }] });
  await source.messages.save(message);

  const service = createBackupService({
    conversations: source.store,
    messages: source.messages,
    roles: createFakeRoles(),
  });

  const exported = await service.exportAll();
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error('导出失败，后续断言无从谈起');
  return exported.data;
}

describe('备份导入', () => {
  it('往返：导入到另一个库后数量对得上，且 id 全部换新（导入永远是追加）', async () => {
    const json = await buildBackupJson();
    const target = createStores();
    const service = createBackupService({
      conversations: target.store,
      messages: target.messages,
      roles: createFakeRoles(),
    });

    const imported = await service.importAll(json);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.data.conversationCount).toBe(2);
    expect(imported.data.messageCount).toBe(1);

    const stored = await target.store.list();
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.data).toHaveLength(2);
    // 原 id 一个都不该被沿用：否则导入同一份备份就会覆盖掉已有数据
    expect(stored.data.map((item) => item.id)).not.toContain(asConversationId('conv-a'));
  });

  it('中途失败时报告**已写入多少**，并提醒再导会重复', async () => {
    const json = await buildBackupJson();
    const target = createStores();
    // 第 2 个会话开始失败：第一个已经进去了
    const failing = createFailAfter(target.store, 2);
    const service = createBackupService({
      conversations: failing.store,
      messages: target.messages,
      roles: createFakeRoles(),
    });

    const imported = await service.importAll(json);

    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.error.message).toContain('导入中途失败');
    expect(imported.error.message).toContain('1 个会话');
    expect(imported.error.message).toContain('重复');
    // 原始原因不能被吃掉：用户要能看到"为什么"
    expect(imported.error.message).toContain('磁盘满了（测试注入）');
    expect(failing.calls()).toBe(2);
  });

  it('不是合法 JSON / 不是本应用的备份文件时，给的是可读的拒绝理由', async () => {
    const target = createStores();
    const service = createBackupService({
      conversations: target.store,
      messages: target.messages,
      roles: createFakeRoles(),
    });

    const broken = await service.importAll('{ 这不是 JSON');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toContain('不是合法的 JSON');

    const wrongKind = await service.importAll(JSON.stringify({ kind: '别的东西', version: 1 }));
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe('VALIDATION_ERROR');
  });
});
