import type { MessageNode } from '@domain/entities/message';
import type { MessageLink } from '@domain/rules/messageTree';
import type { ConversationId, MessageId } from '@shared/ids';
import type { Result } from '@shared/result';

/**
 * 消息（消息树节点）持久化端口
 *
 * 为什么按会话整体拉取而不是逐个节点懒加载：
 * 消息树的**激活路径需要父节点的 `activeChildId` 与兄弟节点才能算出来**，
 * 逐点加载会变成 N+1 次查询。一个会话几千条消息也就几百 KB，一次拉取最省。
 * 等单个会话真的长到影响性能，再改"按子树懒加载"——那时端口形状不用变。
 */
/** 一次正文搜索的命中 —— **一处命中一条**，不是一条消息一条 */
export interface MessageSearchHit {
  conversationId: ConversationId;
  messageId: MessageId;
  /** 命中处的上下文片段（已裁短，供列表直接显示） */
  snippet: string;
  /**
   * 这是该消息里的**第几处**命中（0 起，按屏幕上的先后）
   *
   * 粒度必须是"词"而不是"消息"：
   * 一条消息里出现 8 次同一个词，用户要的是**逐处跳转**；
   * 按消息聚合的话，8 处会被折叠成 1 次，"上一处/下一处"也就形同虚设。
   * 界面还用它来决定**只强调当前那一个词**，而不是整条消息一起变色。
   */
  occurrence: number;
  /**
   * 命中**只在思考过程里**（正文、工具结果里都没有）
   *
   * 界面据此把折叠的思考过程自动展开 —— 否则"跳过去了却什么都看不到"，
   * 用户只会以为搜索坏了。
   *
   * 这个判断放在存储层做，是因为"哪一段文字匹配上了"只有它知道；
   * 让界面拿查询词再去猜一遍，等于把同一套规则写两遍。
   */
  reasoningOnly: boolean;
}

export interface MessageStore {
  /**
   * 粗筛：哪些消息的正文里**可能**出现查询词
   *
   * 只是"候选"—— 精确判断（有没有真的命中、命中在第几处、片段取哪一段）
   * 由应用层的纯函数做，因为它还要结合"这条消息在当前可见路径上吗"。
   * 用 LIKE 扫 `segments_json`：扫描在 SQLite 内部完成，
   * **回传的只有命中行**，不是整库。
   */
  findCandidates(query: string, limit: number): Promise<Result<MessageNode[]>>;

  /**
   * 只取消息树的**连接关系**（不读正文）
   *
   * 跨会话搜索用它算出每个会话"当前可见的是哪条路径"。命中的会话通常只有
   * 一两个，所以这把查询很小；读正文来判断分支则完全是浪费。
   */
  listLinks(conversationIds: readonly ConversationId[]): Promise<Result<MessageLink[]>>;

  listByConversation(conversationId: ConversationId): Promise<Result<MessageNode[]>>;
  /**
   * 全部未删除的消息
   *
   * 只给**备份**用：它是唯一一个"必须看到库里全部消息"的场景。
   * 日常读取一律走 `listByConversation` —— 按会话整体拉取已经够用，
   * 把整个库读进内存只会在备份时才是合理的。
   */
  listAll(): Promise<Result<MessageNode[]>>;
  save(node: MessageNode): Promise<Result<void>>;
  /** 批量写入（例如新建会话时预填开场白） */
  saveMany(nodes: MessageNode[]): Promise<Result<void>>;
  /** 物理删除单条（真正的"抹掉"；日常删除走 `deletedAt` 软删除） */
  purge(id: MessageId): Promise<Result<void>>;

}
