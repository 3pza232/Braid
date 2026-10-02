import type { MessageId } from '@shared/ids';
import type { MessageNode } from '@domain/entities/message';

/**
 * 消息树的纯函数规则
 *
 * 本文件是 domain 层：**零依赖、无副作用、可单测**。
 * 所有"当前显示哪条路径""这条消息有几个变体"的判断都只在这里实现，
 * 仓储层与 UI 层都不允许各自重写一遍。
 */

/** 树索引：一次构建，多处查询 */
/**
 * 按"节点数组的引用"缓存的树索引
 *
 * 【为什么能这样缓存】
 * 消息树是**不可变**的：一次更新换来一整棵新树，未变化的节点对象引用原封不动
 * （`withNodeAdded` / `withNodeTextPatched` 等都是这个写法）。所以以数组本身为键，
 * 重复查同一棵树必然命中，树一变就是新键 —— 不需要任何显式失效逻辑。
 *
 * 【为什么值得】
 * 顶栏的上下文用量在流式期间约 8 次/秒重算，每次都对着整棵树重建索引是纯浪费；
 * 而索引本身是**只读**的（消费方只做查询，没有任何一处会修改它），所以可以安全共享。
 *
 * 用 WeakMap 是为了树被丢弃后缓存自动回收，省掉"忘了清"这类内存泄漏
 * （与 `contextCompression.ts` 按 segments 数组缓存 token 数是同一套思路）。
 */
const indexCache = new WeakMap<readonly MessageNode[], MessageTreeIndex>();

/** 取（可能已缓存的）树索引：同一棵树重复查只建一次 */
export function cachedTreeIndex(nodes: readonly MessageNode[]): MessageTreeIndex {
  const cached = indexCache.get(nodes);
  if (cached !== undefined) return cached;

  const index = buildTreeIndex(nodes);
  indexCache.set(nodes, index);
  return index;
}

export interface MessageTreeIndex {
  byId: Map<MessageId, MessageNode>;
  /** key 为 null 表示"虚拟根"的直接子节点 */
  childIdsOf: Map<MessageId | null, MessageId[]>;
}

export function buildTreeIndex(nodes: readonly MessageNode[]): MessageTreeIndex {
  const byId = new Map<MessageId, MessageNode>();
  const childIdsOf = new Map<MessageId | null, MessageId[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    const bucket = childIdsOf.get(node.parentId);
    if (bucket) bucket.push(node.id);
    else childIdsOf.set(node.parentId, [node.id]);
  }

  // 稳定排序：变体序号优先，其次创建时间。保证 ‹ 1/2 › 的顺序确定、不随查询顺序抖动
  for (const bucket of childIdsOf.values()) {
    bucket.sort((a, b) => {
      const na = byId.get(a);
      const nb = byId.get(b);
      if (!na || !nb) return 0;
      return na.variantIndex - nb.variantIndex || na.createdAt - nb.createdAt;
    });
  }

  return { byId, childIdsOf };
}

export function childrenOf(
  index: MessageTreeIndex,
  parentId: MessageId | null,
  options: { includeDeleted?: boolean } = {},
): MessageNode[] {
  const ids = index.childIdsOf.get(parentId) ?? [];
  const nodes = ids.map((id) => index.byId.get(id)).filter((n): n is MessageNode => !!n);
  return options.includeDeleted ? nodes : nodes.filter((n) => n.deletedAt === null);
}

/**
 * 当前激活路径（用户实际看到的那条"辫子"）
 *
 * 从虚拟根开始，逐级跟随父节点上的 `activeChildId` 向下走。
 * 全树只有这一套机制，因此不存在"两个地方记着当前选中谁"的隐患。
 *
 * 防御：遇到环形引用（数据损坏）或指向已删除节点时立即停止，
 * 保证 UI 不会因坏数据白屏。
 */
/**
 * 激活路径所需的最小信息
 *
 * 三列就够走完一条路径。跨会话搜索要判断"某条命中在不在别人看得见的路径上"，
 * 为了这件事把每个会话的**正文**全读进内存（几百 KB 起）是纯浪费。
 */
export interface MessageLink {
  id: MessageId;
  conversationId: string;
  parentId: MessageId | null;
  activeChildId: MessageId | null;
}

/**
 * 激活路径上的节点 id（按屏幕顺序）
 *
 * `activePathOf` 的**结构版孪生**：那个需要整棵树（含正文），这个只要三列。
 * 两者必须给出同一条路径，为此有一条对照测试盯着 ——
 * 逻辑漂移的风险是真的（两处各写一遍"怎么算当前分支"），
 * 所以不能让它们只有"看起来一样"。
 *
 * 防御与 `activePathOf` 一致：环形引用（数据损坏）或指针指向不存在的节点时停下。
 * 传进来的 links 已由调用方过滤掉软删除的节点，因此"链上有已删除节点"表现为
 * `byId` 查不到 —— 与 `activePathOf` 的 `deletedAt !== null` 判断是同一种收敛。
 */
export function activePathIdsOf(
  links: readonly MessageLink[],
  activeRootChildId: MessageId | null,
): MessageId[] {
  const byId = new Map<MessageId, MessageLink>();
  for (const link of links) byId.set(link.id, link);

  const path: MessageId[] = [];
  const visited = new Set<MessageId>();

  let cursor: MessageId | null = activeRootChildId;
  while (cursor) {
    if (visited.has(cursor)) break;
    visited.add(cursor);

    const link = byId.get(cursor);
    if (!link) break;

    path.push(link.id);
    cursor = link.activeChildId;
  }

  return path;
}

export function activePathOf(
  index: MessageTreeIndex,
  activeRootChildId: MessageId | null,
): MessageNode[] {
  const path: MessageNode[] = [];
  const visited = new Set<MessageId>();

  let cursor: MessageId | null = activeRootChildId;
  while (cursor) {
    if (visited.has(cursor)) break;
    visited.add(cursor);

    const node = index.byId.get(cursor);
    if (!node || node.deletedAt !== null) break;

    path.push(node);
    cursor = node.activeChildId;
  }

  return path;
}

/** 同一逻辑消息的全部可见变体（用于气泡上的 ‹ 2/3 › 切换） */
export function variantsOf(index: MessageTreeIndex, node: MessageNode): MessageNode[] {
  return childrenOf(index, node.parentId).filter((n) => n.variantOf === node.variantOf);
}

export function variantPosition(
  index: MessageTreeIndex,
  node: MessageNode,
): { position: number; total: number } {
  const variants = variantsOf(index, node);
  const position = variants.findIndex((n) => n.id === node.id);
  return { position: position < 0 ? 0 : position, total: variants.length };
}

/** 切换变体：给定当前节点与偏移量（-1 上一个 / +1 下一个），返回目标节点 */
export function shiftVariant(
  index: MessageTreeIndex,
  node: MessageNode,
  delta: number,
): MessageNode | null {
  const variants = variantsOf(index, node);
  if (variants.length <= 1) return null;
  const current = variants.findIndex((n) => n.id === node.id);
  if (current < 0) return null;
  const next = (current + delta + variants.length) % variants.length;
  return variants[next] ?? null;
}


