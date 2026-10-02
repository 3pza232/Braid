import type { Conversation } from '@domain/entities/conversation';
import type { ConversationId } from '@shared/ids';
import type { Result } from '@shared/result';

/**
 * 会话持久化端口
 *
 * 注意 `list()` 只返回**未删除**的会话：软删除的会话不进列表，
 * 但数据仍在库里（未来做"回收站"时不用改存储层）。
 */
export interface ConversationStore {
  /** 按更新时间倒序返回全部未删除会话 */
  list(): Promise<Result<Conversation[]>>;
  save(conversation: Conversation): Promise<Result<void>>;
  /**
   * 批量保存（**一个事务**）
   *
   * 排序调整会一次改动很多行：逐条 `save` 一旦中途失败，就留下"半个新顺序" ——
   * 每行都合法、合起来是乱的，而且用户完全看不出发生过什么。
   * 与 `MessageStore.saveMany` 同一套做法（底层 `SqlPort.batch` 是一个事务）。
   */
  saveMany(conversations: readonly Conversation[]): Promise<Result<void>>;
  /** 软删除：只打 `deleted_at` 标记，不物理删除 */
  remove(id: ConversationId, now: number): Promise<Result<void>>;
}
