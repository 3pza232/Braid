import type { MessageNode } from '@domain/entities/message';
import type { MessageLink } from '@domain/rules/messageTree';
import type { SqlPort, SqlValue } from '@ports/host/SqlPort';
import type { MessageStore } from '@ports/repositories/MessageStore';
import { asMessageId, type MessageId } from '@shared/ids';
import { ok, type Result } from '@shared/result';
import { MESSAGE_UPSERT_SQL, messageFromRow, messageParams } from './messageRows';
import { toText, type SqlRow } from './rows';

/**
 * 基于 SQLite 的消息存储
 *
 * 按会话整体拉取（不做懒加载），理由见 `MessageStore` 端口的注释。
 */
export function createSqliteMessageStore(sql: SqlPort): MessageStore {
  return {
    async listByConversation(conversationId: string): Promise<Result<MessageNode[]>> {
      const result = await sql.query<SqlRow>(
        'SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC',
        [conversationId],
      );
      if (!result.ok) return result;
      return ok(result.data.map(messageFromRow));
    },

    async listAll(): Promise<Result<MessageNode[]>> {
      const result = await sql.query<SqlRow>(
        'SELECT * FROM message WHERE deleted_at IS NULL ORDER BY conversation_id ASC, created_at ASC',
        [],
      );
      if (!result.ok) return result;
      return ok(result.data.map(messageFromRow));
    },

    async save(node: MessageNode): Promise<Result<void>> {
      const result = await sql.execute(MESSAGE_UPSERT_SQL, messageParams(node));
      if (!result.ok) return result;
      return ok(undefined);
    },

    async saveMany(nodes: MessageNode[]): Promise<Result<void>> {
      if (nodes.length === 0) return ok(undefined);
      // 放进一个事务：要么全部写入，要么一条不写，避免"半个开场白"这种残局
      const result = await sql.batch(
        nodes.map((node) => ({ sql: MESSAGE_UPSERT_SQL, params: messageParams(node) })),
      );
      if (!result.ok) return result;
      return ok(undefined);
    },

    async purge(id: MessageId): Promise<Result<void>> {
      const result = await sql.execute('DELETE FROM message WHERE id = ?', [id]);
      if (!result.ok) return result;
      return ok(undefined);
    },

    async findCandidates(query: string, limit: number): Promise<Result<MessageNode[]>> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return ok([]);

      /*
       * LIKE 扫 `segments_json`
       *
       * 扫的是 JSON 原文，所以也会命中结构字段（角色名、工具参数……）——
       * 没关系：这只是一份**候选**，精确判断在应用层（它还会滤掉旧分支、
       * 排除工具结果、算出命中在第几处）。这里的职责是"用一条 SQL
       * 把绝大多数行挡在内存之外"。
       *
       * `ESCAPE` 必须写：用户搜 `%` 或 `_` 时它们在 LIKE 里是通配符，
       * 不转义就会"搜什么都命中一片"。
       */
      const pattern = `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const result = await sql.query<SqlRow>(
        `SELECT * FROM message
          WHERE deleted_at IS NULL AND segments_json LIKE ? ESCAPE '\\'
          ORDER BY created_at DESC
          LIMIT ?`,
        [pattern, limit],
      );
      if (!result.ok) return result;
      return ok(result.data.map(messageFromRow));
    },

    async listLinks(conversationIds: readonly string[]): Promise<Result<MessageLink[]>> {
      if (conversationIds.length === 0) return ok([]);

      // 只取走路径要用的四列：这一步存在的意义就是"不读正文"
      const placeholders = conversationIds.map(() => '?').join(', ');
      const result = await sql.query<SqlRow>(
        `SELECT id, conversation_id, parent_id, active_child_id FROM message
          WHERE deleted_at IS NULL AND conversation_id IN (${placeholders})`,
        [...conversationIds],
      );
      if (!result.ok) return result;

      return ok(
        result.data.map((row) => ({
          id: asMessageId(String(row['id'])),
          conversationId: String(row['conversation_id']),
          parentId: toIdOrNull(row['parent_id']),
          activeChildId: toIdOrNull(row['active_child_id']),
        })),
      );
    },
  };
}

/** id 类列的容错取值：空串与 null 一律当"没有"，坏数据不许冒到上层 */
function toIdOrNull(raw: SqlValue | undefined): MessageId | null {
  const text = toText(raw);
  return text === null || text.length === 0 ? null : asMessageId(text);
}

