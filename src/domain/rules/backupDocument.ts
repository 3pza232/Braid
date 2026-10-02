import type { Conversation } from '@domain/entities/conversation';
import type { MessageNode } from '@domain/entities/message';
import type { RolePreset } from '@domain/entities/rolePreset';

/**
 * 备份文档：一次导出/导入的全部数据
 *
 * 【为什么必须有这件事】
 * 本地优先应用最大的风险不是服务器挂了，而是**数据只在这一台机器、这一个浏览器
 * 源上**。换电脑、换端口（浏览器按 origin 隔离存储）、清理浏览器数据，
 * 任何一件都会让全部对话消失 —— 而这个应用里的一切都是用户自己攒的。
 *
 * 【为什么不含设置】
 * 设置里有 API Key（明文）。备份文件的流转方式不可控（可能发给人、放网盘），
 * 把凭据一起带上等于埋一个长期的泄露点。设置本身也大多是"这台机器"的性质
 * （端点、Key、工作区），换台机器本来就要重配。
 */
export interface BackupDocument {
  /** 固定标记：用来认出"这是 Braid 的备份"，而不是随便一个 JSON */
  kind: 'braid-backup';
  version: 1;
  exportedAt: number;
  conversations: Conversation[];
  messages: MessageNode[];
  roles: RolePreset[];
}

export const BACKUP_KIND = 'braid-backup';
export const BACKUP_VERSION = 1;

export interface ParsedBackup {
  document: BackupDocument;
  /** 被丢弃的条目数（结构不完整的数据）。界面必须如实告诉用户，不能装作全都进来了 */
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析备份文件
 *
 * 策略是"认不出来就整体拒绝，认得出来就尽量收下"：
 *  - 不是备份（`kind` 不对）→ 整体失败，并说清为什么；
 *  - 个别条目结构坏了 → 丢掉那一条并**计数**，不让它把整份备份带下去。
 * 与导入角色同一套取舍：容错优先，但绝不静默。
 */
export function parseBackupDocument(raw: unknown): { ok: true; data: ParsedBackup } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '文件内容不是一个 JSON 对象' };
  if (raw.kind !== BACKUP_KIND) {
    return { ok: false, reason: '这不是 Braid 的备份文件' };
  }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    return { ok: false, reason: `备份版本（${String(raw.version)}）比当前程序更新，请先升级` };
  }

  const conversations = pickArray<Conversation>(raw.conversations, (item) =>typeof item.id === 'string' && typeof item.title === 'string');
  const messages = pickArray<MessageNode>(
    raw.messages,
    (item) =>
      typeof item.id === 'string' &&
      typeof item.conversationId === 'string' &&
      typeof item.role === 'string' &&
      Array.isArray(item.segments),
  );
  const roles = pickArray<RolePreset>(
    raw.roles,
    (item) => typeof item.id === 'string' && typeof item.name === 'string',
  );

  return {
    ok: true,
    data: {
      document: {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : Date.now(),
        conversations: conversations.items,
        messages: messages.items,
        roles: roles.items,
      },
      skipped: conversations.skipped + messages.skipped + roles.skipped,
    },
  };
}

function pickArray<T>(value: unknown, valid: (item: Record<string, unknown>) => boolean): { items: T[]; skipped: number } {
  if (!Array.isArray(value)) return { items: [], skipped: 0 };
  const items: T[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (isRecord(entry) && valid(entry)) items.push(entry as unknown as T);
    else skipped += 1;
  }
  return { items, skipped };
}

export interface RemapResult {
  document: BackupDocument;
  conversationCount: number;
  messageCount: number;
  roleCount: number;
  /** 引用了不存在的会话/角色、因而被丢弃的消息数 */
  droppedMessages: number;
}

/**
 * 重新分配全部 id（导入时**必须**做这一步）
 *
 * 【为什么不能直接原样导入】
 * 导出再导入到自己这里（换台机器后又导回来、或者只想恢复几条对话）时，
 * 原 id 会与库里已有的记录**撞车**。而这些都是 upsert：撞上就直接覆盖，
 * 用户会发现"我导入了一份备份，结果把现在的对话覆盖了"。
 * 重新发号之后，导入永远是"追加"，不会动到任何已有数据。
 *
 * 【id 之间的引用必须一起改】
 * `parentId` / `variantOf` / `activeChildId` 是消息树的结构，`conversationId`
 * 指向所属会话，角色实例里的 `roleId` 指向角色预设 —— 只改主键不改引用，
 * 树会立刻散架（消息全部变成孤儿）。
 *
 * `nextId` 由调用方注入：领域层不引入随机数，测试里就能给出确定的 id。
 */
export function remapBackup(
  document: BackupDocument,
  nextId: (prefix: string) => string,
  now: number,
): RemapResult {
  const roleIds = new Map<string, string>();
  for (const role of document.roles) roleIds.set(role.id, nextId('role'));

  const conversationIds = new Map<string, string>();
  for (const conversation of document.conversations) {
    conversationIds.set(conversation.id, nextId('conv'));
  }

  const messageIds = new Map<string, string>();
  for (const message of document.messages) {
    // 只给"所属会话也在备份里"的消息发号，否则导入后会变成无主消息
    if (conversationIds.has(message.conversationId)) messageIds.set(message.id, nextId('msg'));
  }

  const remapId = (id: string | null | undefined, map: Map<string, string>): string | null =>
    id === null || id === undefined ? null : (map.get(id) ?? null);

  const conversations: Conversation[] = document.conversations.map((conversation) => ({
    ...conversation,
    id: conversationIds.get(conversation.id)! as Conversation['id'],
    roleId: (conversation.roleId ? remapId(conversation.roleId, roleIds) : null) as Conversation['roleId'],
    roleInstance: conversation.roleInstance
      ? {
          ...conversation.roleInstance,
          roleId: remapId(conversation.roleInstance.roleId, roleIds) as Conversation['roleId'],
        }
      : null,
    activeRootChildId: remapId(conversation.activeRootChildId, messageIds) as Conversation['activeRootChildId'],
    updatedAt: now,
    createdAt: conversation.createdAt,
  }));

  let droppedMessages = 0;
  const messages: MessageNode[] = [];
  for (const message of document.messages) {
    const newId = messageIds.get(message.id);
    if (!newId) {
      droppedMessages += 1;
      continue;
    }
    messages.push({
      ...message,
      id: newId as MessageNode['id'],
      conversationId: conversationIds.get(message.conversationId)! as MessageNode['conversationId'],
      parentId: remapId(message.parentId, messageIds) as MessageNode['parentId'],
      // 变体组长的 id 必须落在同一份备份里，否则退回把自己当成组长
      variantOf: (remapId(message.variantOf, messageIds) ?? newId) as MessageNode['variantOf'],
      activeChildId: remapId(message.activeChildId, messageIds) as MessageNode['activeChildId'],
    });
  }

  const roles: RolePreset[] = document.roles.map((role) => ({
    ...role,
    id: roleIds.get(role.id)! as RolePreset['id'],
    // 出厂样例的标志要保留：导入一份样例角色后，它仍然是"样例"
    updatedAt: now,
  }));

  return {
    document: { ...document, exportedAt: now, conversations, messages, roles },
    conversationCount: conversations.length,
    messageCount: messages.length,
    roleCount: roles.length,
    droppedMessages,
  };
}
