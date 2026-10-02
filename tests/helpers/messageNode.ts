import { CURRENT_MESSAGE_SCHEMA_VERSION, type MessageNode } from '@domain/entities/message';
import type { TreeState } from '@domain/rules/messageTreeEdits';
import { asConversationId, asMessageId, type MessageId } from '@shared/ids';

/**
 * 覆盖项：`conversationId` 放宽成普通字符串
 *
 * 写测试时 `conversationId: 'conv-old'` 比 `asConversationId('conv-old')` 顺手得多，
 * 而这里正是测试的数据边界 —— 转换集中在这一处，各用例不必各自加转换。
 */
type NodeOverrides = Partial<Omit<MessageNode, 'conversationId'>> & { conversationId?: string };

/**
 * 造一个测试用消息节点
 *
 * 为什么放在 helpers 而不是各测试文件各写一份：树规则与编辑规则**必须**用
 * 同一套默认值来验证，否则两边对"什么算默认"的理解会各自漂移，
 * 测试就会在互相矛盾的假设上通过。
 *
 * 默认值刻意选成"最普通的一条消息"：根层、无子节点、已完成、未被删除。
 * 需要变体 / 分支 / 删除时由调用方覆盖相应字段。
 */
export function node(id: string, overrides: NodeOverrides = {}): MessageNode {
  const { conversationId, ...rest } = overrides;

  return {
    id: asMessageId(id),
    parentId: null,
    // 自身即变体组组长
    variantOf: asMessageId(id),
    variantIndex: 0,
    activeChildId: null,
    role: 'assistant',
    segments: [{ kind: 'text', text: id }],
    status: 'complete',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    schemaVersion: CURRENT_MESSAGE_SCHEMA_VERSION,
    ...rest,
    // 放在 spread 之后：覆盖值里的 `conversationId` 是普通字符串，转在这里
    conversationId: asConversationId(conversationId ?? 'c1'),
  };
}

/** 只写断言真正关心的字段，其余走 `node` 的默认值 */
export function tree(nodes: MessageNode[], activeRootChildId: string | null = null): TreeState {
  return {
    nodes,
    activeRootChildId: activeRootChildId === null ? null : asMessageId(activeRootChildId),
  };
}

/** 取一条消息的全部文本（拼接文本段），断言正文时比比对 segments 数组更直观 */
export function textOf(target: MessageNode): string {
  return target.segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('');
}

export const asId = (raw: string): MessageId => asMessageId(raw);
