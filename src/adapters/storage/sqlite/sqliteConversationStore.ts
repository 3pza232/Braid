import type { Conversation } from '@domain/entities/conversation';
import type { SqlPort } from '@ports/host/SqlPort';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { ConversationId } from '@shared/ids';
import { ok, type Result } from '@shared/result';
import { CONVERSATION_UPSERT_SQL, conversationFromRow, conversationParams } from './conversationRows';
import type { SqlRow } from './rows';

/**
 * 基于 SQLite 的会话存储
 *
 * 列表按 `updated_at DESC` 排序由 SQL 完成（走 `idx_conversation_updated` 索引），
 * 不在 JS 里排序 —— 会话多起来时这个差别是 O(n log n) 与 O(log n) 的差别。
 */
export function createSqliteConversationStore(sql: SqlPort): ConversationStore {
  return {
    async list(): Promise<Result<Conversation[]>> {
      const result = await sql.query<SqlRow>(
        'SELECT * FROM conversation WHERE deleted_at IS NULL ORDER BY updated_at DESC',
      );
      if (!result.ok) return result;
      return ok(result.data.map(conversationFromRow));
    },

    async save(conversation: Conversation): Promise<Result<void>> {
      const result = await sql.execute(CONVERSATION_UPSERT_SQL, conversationParams(conversation));
      if (!result.ok) return result;
      return ok(undefined);
    },

    async saveMany(conversations: readonly Conversation[]): Promise<Result<void>> {
      if (conversations.length === 0) return ok(undefined);
      // 一个事务：要么全部写入，要么一条都不写（避免"半个新顺序"这种残局）
      return sql.batch(
        conversations.map((conversation) => ({
          sql: CONVERSATION_UPSERT_SQL,
          params: conversationParams(conversation),
        })),
      );
    },

    async remove(id: ConversationId, now: number): Promise<Result<void>> {
      // 软删除：数据留在库里，未来做"回收站"时不用改存储层
      const result = await sql.execute(
        'UPDATE conversation SET deleted_at = ?, updated_at = ? WHERE id = ?',
        [now, now, id],
      );
      if (!result.ok) return result;
      return ok(undefined);
    },
  };
}
