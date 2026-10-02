import type { Conversation, ForkOrigin } from '@domain/entities/conversation';
import {
  CURRENT_CONVERSATION_SCHEMA_VERSION,
  createEmptyConversation,
  DEFAULT_CONVERSATION_TITLE,
} from '@domain/entities/conversation';
import type { RoleInstance } from '@domain/entities/roleInstance';
import type { SamplingParams } from '@domain/value-objects/sampling';
import { WRITING_MODES, type WritingMode } from '@domain/value-objects/writingMode';
import type { MessageId } from '@shared/ids';
import { asConversationId, asMessageId, asRoleId } from '@shared/ids';
import type { SqlValue } from '@ports/host/SqlPort';
import {
  buildUpsert,
  isPlainObject,
  parseJson,
  parseJsonObject,
  toInt,
  toJson,
  toNumOrNull,
  toText,
  type SqlRow,
} from './rows';

export const CONVERSATION_COLUMNS = [
  'id',
  'title',
  'workspace_root',
  'role_instance_json',
  'role_id',
  'model_profile_id',
  'model',
  'params_json',
  'system_prompt',
  'writing_mode',
  'min_output_chars',
  'continuation_prompt',
  'keep_recent_messages',
  'assistant_name',
  'user_name',
  'active_root_child_id',
  'forked_from_json',
  'sort_order',
  'created_at',
  'updated_at',
  'deleted_at',
  'extensions_json',
  'schema_version',
] as const;

type ConversationColumn = (typeof CONVERSATION_COLUMNS)[number];

export const CONVERSATION_UPSERT_SQL = buildUpsert('conversation', CONVERSATION_COLUMNS);

/**
 * 角色实例是**不透明快照**：存储层只负责往返，不需要知道它有哪些字段。
 * 这样以后给 `RoleInstance` 加字段，这里一行都不用改。
 *
 * 但"不透明"不等于"不检查形状"：那一格若是数组或标量（手工改坏、旧版本写坏），
 * 读成角色实例后界面会在 `roleInstance.avatar.color` 上抛错 —— 整条会话列表打不开。
 */
function toRoleInstance(raw: SqlValue | undefined): RoleInstance | null {
  const parsed = parseJson<unknown>(raw, null);
  return isPlainObject(parsed) ? (parsed as unknown as RoleInstance) : null;
}

function toForkOrigin(raw: SqlValue | undefined): ForkOrigin | null {
  const parsed = parseJson<unknown>(raw, null);
  if (!isPlainObject(parsed)) return null;
  if (typeof parsed.conversationId !== 'string' || typeof parsed.messageId !== 'string') return null;
  return {
    conversationId: asConversationId(parsed.conversationId),
    messageId: asMessageId(parsed.messageId),
  };
}

/**
 * 输出档位
 *
 * 与角色、状态一样**按清单校验**：认不出的值退回"普通对话"，
 * 而不是让它带着 `'epic'` 这种值一路进到领域层（那里会当成有效的档位去查表）。
 */
function toWritingMode(raw: SqlValue | undefined): WritingMode | 'chat' {
  return WRITING_MODES.includes(raw as WritingMode) ? (raw as WritingMode) : 'chat';
}

function toMessageIdOrNull(raw: SqlValue | undefined): MessageId | null {
  const text = toText(raw);
  return text === null ? null : asMessageId(text);
}

function conversationToRowObject(conversation: Conversation): Record<ConversationColumn, SqlValue> {
  return {
    id: conversation.id,
    title: conversation.title,
    workspace_root: toText(conversation.workspaceRoot),
    role_instance_json: conversation.roleInstance ? toJson(conversation.roleInstance) : null,
    role_id: conversation.roleId,
    model_profile_id: toText(conversation.modelProfileId),
    model: toText(conversation.model),
    params_json: toJson(conversation.params),
    system_prompt: conversation.systemPrompt,
    writing_mode: conversation.writingMode,
    // 用 toNumOrNull 而不是 toInt：null 的语义是"继承全局档位"，绝不能变成 0
    min_output_chars: conversation.minOutputChars,
    continuation_prompt: conversation.continuationPrompt,
    // null 的语义是"继承全局保留轮数"，绝不能被压成 0
    keep_recent_messages: conversation.keepRecentMessages,
    assistant_name: toText(conversation.assistantName),
    user_name: toText(conversation.userName),
    active_root_child_id: conversation.activeRootChildId,
    sort_order: conversation.sortOrder,
    forked_from_json: conversation.forkedFrom ? toJson(conversation.forkedFrom) : null,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    deleted_at: conversation.deletedAt,
    extensions_json: toJson(conversation.extensions ?? {}),
    schema_version: conversation.schemaVersion,
  };
}

export function conversationParams(conversation: Conversation): SqlValue[] {
  const row = conversationToRowObject(conversation);
  return CONVERSATION_COLUMNS.map((column) => row[column]);
}

export function conversationFromRow(row: SqlRow): Conversation {
  const createdAt = toInt(row['created_at'], Date.now());
  const id = asConversationId(String(row['id'] ?? ''));
  const roleId = toText(row['role_id']);
  const extensions = parseJsonObject<Record<string, unknown>>(row['extensions_json'], {});

  return createEmptyConversation(id, createdAt, {
    title: typeof row['title'] === 'string' ? row['title'] : DEFAULT_CONVERSATION_TITLE,
    workspaceRoot: toText(row['workspace_root']),
    roleInstance: toRoleInstance(row['role_instance_json']),
    roleId: roleId === null ? null : asRoleId(roleId),
    modelProfileId: toText(row['model_profile_id']),
    model: toText(row['model']),
    params: parseJsonObject<SamplingParams>(row['params_json'], {}),
    systemPrompt: row['system_prompt'] === null || row['system_prompt'] === undefined
      ? null
      : String(row['system_prompt']),
    writingMode: toWritingMode(row['writing_mode']),
    minOutputChars: toNumOrNull(row['min_output_chars']),
    continuationPrompt:
      row['continuation_prompt'] === null || row['continuation_prompt'] === undefined
        ? null
        : String(row['continuation_prompt']),
    keepRecentMessages: toNumOrNull(row['keep_recent_messages']),
    assistantName: toText(row['assistant_name']),
    userName: toText(row['user_name']),
    activeRootChildId: toMessageIdOrNull(row['active_root_child_id']),
    forkedFrom: toForkOrigin(row['forked_from_json']),
    sortOrder: toNumOrNull(row['sort_order']),
    updatedAt: toInt(row['updated_at'], createdAt),
    deletedAt: toNumOrNull(row['deleted_at']),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    schemaVersion: toInt(row['schema_version'], CURRENT_CONVERSATION_SCHEMA_VERSION),
  });
}


