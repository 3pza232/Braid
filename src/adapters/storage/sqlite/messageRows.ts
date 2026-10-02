import type {
  ContextFlags,
  FinishReason,
  MessageNode,
  MessageRole,
  MessageSegment,
  MessageStatus,
} from '@domain/entities/message';
import {
  CURRENT_MESSAGE_SCHEMA_VERSION,
  FINISH_REASONS,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from '@domain/entities/message';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';
import type { MessageId } from '@shared/ids';
import { asConversationId, asMessageId } from '@shared/ids';
import type { SqlValue } from '@ports/host/SqlPort';
import {
  buildUpsert,
  parseJson,
  parseJsonObject,
  toInt,
  toJson,
  toNumOrNull,
  toText,
  type SqlRow,
} from './rows';

export const MESSAGE_COLUMNS = [
  'id',
  'conversation_id',
  'parent_id',
  'variant_of',
  'variant_index',
  'active_child_id',
  'role',
  'segments_json',
  'status',
  'model_ref',
  'params_snapshot_json',
  'role_id_at_creation',
  'usage_json',
  'finish_reason',
  'context_flags_json',
  'created_at',
  'updated_at',
  'deleted_at',
  'extensions_json',
  'schema_version',
] as const;

type MessageColumn = (typeof MESSAGE_COLUMNS)[number];

export const MESSAGE_UPSERT_SQL = buildUpsert('message', MESSAGE_COLUMNS);

/* ────────────────── 容错取值：坏数据不许冒到界面 ────────────────── */

/*
 * 取值清单**从领域层 import**，不在这里另抄一份
 *
 * 抄一份的代价是：领域里加一个结束原因，这里会把它当坏数据丢掉（而且不报错）。
 */

function toRole(raw: SqlValue | undefined): MessageRole {
  return MESSAGE_ROLES.includes(raw as MessageRole) ? (raw as MessageRole) : 'assistant';
}

function toStatus(raw: SqlValue | undefined): MessageStatus {
  return MESSAGE_STATUSES.includes(raw as MessageStatus) ? (raw as MessageStatus) : 'complete';
}

function toFinishReason(raw: SqlValue | undefined): FinishReason | null {
  return FINISH_REASONS.includes(raw as FinishReason) ? (raw as FinishReason) : null;
}

function toMessageId(raw: SqlValue | undefined): MessageId | null {
  const text = toText(raw);
  return text === null ? null : asMessageId(text);
}

/**
 * 分段数组的容错
 *
 * 只保留**结构上认得出来**的段：未知 kind 直接丢弃。
 * 因为界面渲染分段时必须穷尽 kind，留一个不认识的段进去会让整个消息渲染失败 ——
 * 宁可少显示一段，也不能让一条消息白屏。
 */
function toSegments(raw: SqlValue | undefined): MessageSegment[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];

  const out: MessageSegment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    if (
      kind === 'text' ||
      kind === 'reasoning' ||
      kind === 'tool_call' ||
      kind === 'tool_result' ||
      kind === 'summary' ||
      kind === 'image'
    ) {
      out.push(item as MessageSegment);
    }
  }
  return out;
}

/* ────────────────── 映射 ────────────────── */

/**
 * 段落序列化的**按段缓存**
 *
 * 流式输出期间每 1.5s 落库一次，而一条消息里最长的那些段（工具结果上限 2 万字）
 * 根本没变过 —— 每次把它们重新 `JSON.stringify` 一遍是纯烧 CPU，
 * 长会话 + 大工具输出时这一下是能感觉到的。
 *
 * 之所以能按**对象身份**缓存：段是不可变的，领域层的每次修改都会产生新对象，
 * 所以"同一个引用"就等于"内容没变"（这也正是 `changedNodes` 判定脏节点的依据）。
 */
const segmentJsonCache = new WeakMap<MessageSegment, string>();

/**
 * 序列化段落数组
 *
 * 结果与 `JSON.stringify(segments)` **逐字节相同**（用逗号拼接各段的序列化结果，
 * 而 `JSON.stringify` 对数组正是这个形状），这一点由单测锁住 ——
 * 这个字段是正文的**唯一**存放处，拼错一个字符就是静默的数据损坏。
 */
export function serializeSegments(segments: readonly MessageSegment[]): string {
  let out = '[';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let json = segmentJsonCache.get(segment);
    if (json === undefined) {
      json = JSON.stringify(segment);
      segmentJsonCache.set(segment, json);
    }
    out += index === 0 ? json : `,${json}`;
  }
  return `${out}]`;
}

function messageToRowObject(node: MessageNode): Record<MessageColumn, SqlValue> {
  return {
    id: node.id,
    conversation_id: node.conversationId,
    parent_id: node.parentId,
    variant_of: node.variantOf,
    variant_index: node.variantIndex,
    active_child_id: node.activeChildId,
    role: node.role,
    segments_json: serializeSegments(node.segments),
    status: node.status,
    model_ref: toText(node.modelRef),
    params_snapshot_json: node.paramsSnapshot ? toJson(node.paramsSnapshot) : null,
    role_id_at_creation: toText(node.roleIdAtCreation),
    usage_json: node.usage ? toJson(node.usage) : null,
    finish_reason: node.finishReason ?? null,
    context_flags_json: toJson(node.contextFlags ?? {}),
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    deleted_at: node.deletedAt,
    extensions_json: toJson(node.extensions ?? {}),
    schema_version: node.schemaVersion,
  };
}

export function messageParams(node: MessageNode): SqlValue[] {
  const row = messageToRowObject(node);
  return MESSAGE_COLUMNS.map((column) => row[column]);
}

export function messageFromRow(row: SqlRow): MessageNode {
  const createdAt = toInt(row['created_at'], Date.now());
  const id = asMessageId(String(row['id'] ?? ''));
  const modelRef = toText(row['model_ref']);
  const paramsSnapshot = parseJsonObject<SamplingParams | null>(row['params_snapshot_json'], null);
  const roleIdAtCreation = toText(row['role_id_at_creation']);
  const usage = parseJsonObject<TokenUsage | null>(row['usage_json'], null);
  const finishReason = toFinishReason(row['finish_reason']);
  const extensions = parseJsonObject<Record<string, unknown>>(row['extensions_json'], {});

  return {
    id,
    // 数据库行是外部边界：在这里把裸字符串收成品牌类型
    conversationId: asConversationId(String(row['conversation_id'] ?? '')),
    parentId: toMessageId(row['parent_id']),
    variantOf: toMessageId(row['variant_of']) ?? id,
    variantIndex: toInt(row['variant_index'], 0),
    activeChildId: toMessageId(row['active_child_id']),
    role: toRole(row['role']),
    segments: toSegments(row['segments_json']),
    status: toStatus(row['status']),
    ...(modelRef ? { modelRef } : {}),
    ...(paramsSnapshot ? { paramsSnapshot } : {}),
    ...(roleIdAtCreation ? { roleIdAtCreation } : {}),
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
    contextFlags: parseJsonObject<ContextFlags>(row['context_flags_json'], {}),
    createdAt,
    updatedAt: toInt(row['updated_at'], createdAt),
    deletedAt: toNumOrNull(row['deleted_at']),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    schemaVersion: toInt(row['schema_version'], CURRENT_MESSAGE_SCHEMA_VERSION),
  };
}
