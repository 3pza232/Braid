import type { MessageId } from '@shared/ids';
import type { MessageNode, MessageSegment } from '@domain/entities/message';
import { buildTreeIndex, type MessageTreeIndex } from './messageTree';

/**
 * 消息树的「编辑操作」纯函数
 *
 * 全部是 **不可变操作**：输入旧状态，返回新状态，不修改入参。
 * 这样 UI 只需要 `set(newState)`，重放、撤销、单测都很自然。
 *
 * 关键语义来自 ADR-006「编辑即分支」：
 *  - 编辑 AI 回复 → 在**同一变体组**内新增一个变体，原内容一字不改地保留；
 *  - 编辑用户提问 → 这是**一条新的逻辑消息**，与原提问互为兄弟（可切回）；
 *  - 没有任何操作会覆盖已有节点的正文。
 */
export interface TreeState {
  nodes: MessageNode[];
  /** 虚拟根的当前选中分支（首条消息没有父节点，所以指针挂在会话上） */
  activeRootChildId: MessageId | null;
}

export function indexOf(state: TreeState): MessageTreeIndex {
  return buildTreeIndex(state.nodes);
}

/** 把「父节点 → 选中哪个孩子」这套机制统一封装：父节点为 null 时改的是虚拟根指针 */
function setActiveChild(
  state: TreeState,
  parentId: MessageId | null,
  childId: MessageId | null,
): TreeState {
  if (parentId === null) {
    return { ...state, activeRootChildId: childId };
  }
  return {
    ...state,
    nodes: state.nodes.map((node) =>
      node.id === parentId ? { ...node, activeChildId: childId } : node,
    ),
  };
}

/** 读取「父节点当前选中的孩子」 */
export function activeChildOf(state: TreeState, parentId: MessageId | null): MessageId | null {
  if (parentId === null) return state.activeRootChildId;
  return state.nodes.find((n) => n.id === parentId)?.activeChildId ?? null;
}

/** 追加节点，并（可选）把它设为父节点的当前选中分支 */
export function withNodeAdded(
  state: TreeState,
  node: MessageNode,
  options: { activate?: boolean } = {},
): TreeState {
  const next: TreeState = { ...state, nodes: [...state.nodes, node] };
  return options.activate === false ? next : setActiveChild(next, node.parentId, node.id);
}

/** 切换某个父节点选中的孩子（变体切换 / 分支切换） */
export function withActiveChild(
  state: TreeState,
  parentId: MessageId | null,
  childId: MessageId,
): TreeState {
  const target = state.nodes.find((n) => n.id === childId);
  /*
   * 两种指针都必须拒绝：
   *  - 指向**已删除**的节点 → 路径会在它那里断掉，界面看起来"这条消息没了"；
   *  - 指向**不存在**的节点 → 同样是断在半空，而且更难查（数据里凭空多一个 id）。
   * 早先只挡了前一种，于是传一个不存在的 id 也会被写进指针。
   */
  if (!target || target.deletedAt !== null) return state;
  return setActiveChild(state, parentId, childId);
}

/**
 * 原地替换一条消息的正文
 *
 * 用于「只保存、不重发」：改一句话不该产生新版本。
 *
 * 只处理文本段：`tool_call` / `tool_result` / `reasoning` 等其它段原样保留，
 * 避免"改一句话"把工具调用的轨迹一并抹掉；多余的文本段会合并成一段。
 */
export function withNodeTextPatched(
  state: TreeState,
  id: MessageId,
  text: string,
  now: number,
): TreeState {
  return {
    ...state,
    nodes: state.nodes.map((node) => {
      if (node.id !== id) return node;

      const segments: MessageSegment[] = [];
      let replaced = false;
      for (const segment of node.segments) {
        if (segment.kind === 'text') {
          if (!replaced) {
            segments.push({ kind: 'text', text });
            replaced = true;
          }
          continue;
        }
        segments.push(segment);
      }
      if (!replaced) segments.push({ kind: 'text', text });

      return { ...node, segments, updatedAt: now };
    }),
  };
}

/**
 * 软删除**单条**消息（不连带后续）—— 界面上的"删除此条消息"走这条
 *
 * 【和下面的 `withSoftDelete` 差在哪：这里不动子孙】
 * 用户点删除，要删的是"这一条"。他后面说过的话是他自己写的，不该跟着消失。
 * 所以把孩子**接到它的父节点上**（等于在链上跳过这一环）：
 * `… → 前一条 → 后一条……`，只是少了一环，后面的都还在。
 *
 * 【要一起改对的地方】
 *  - 孩子的 `parentId` 改指祖父。不改的话它们就是"挂在一条已删除消息下面"，
 *    激活路径会在被删的那一环断掉 —— 界面表现是"后面的消息全都看不见了"，
 *    正是要避免的那种结果；
 *  - `variantOf` **保持不动**：变体分组是"同一父节点下、variantOf 相同"的那些
 *    （`variantsOf`），所以接过来的孩子仍然只和它们自己那一组互为一组，
 *    不会跟新父节点下原有的兄弟混成一组；
 *  - 父节点的选中指针若指着被删的这条，改成它**接过来的第一个孩子**，
 *    这样当前这条线不会断在半空。
 */
export function withNodeRemoved(state: TreeState, id: MessageId, now: number): TreeState {
  const target = state.nodes.find((node) => node.id === id);
  if (!target || target.deletedAt !== null) return state;

  const index = buildTreeIndex(state.nodes);
  const promoted = (index.childIdsOf.get(id) ?? [])
    .map((childId) => state.nodes.find((node) => node.id === childId))
    .filter((node): node is MessageNode => !!node && node.deletedAt === null);

  const nodes = state.nodes.map((node) => {
    if (node.id === id) return { ...node, deletedAt: now, updatedAt: now };
    if (!promoted.some((child) => child.id === node.id)) return node;
    return { ...node, parentId: target.parentId, updatedAt: now };
  });

  let next: TreeState = { ...state, nodes };

  if (activeChildOf(next, target.parentId) === id) {
    next = setActiveChild(next, target.parentId, promoted[0]?.id ?? null);
  }

  return next;
}

/**
 * 软删除**整条分支**（连同后续）
 *
 * 删除当前选中分支时，会把父节点的选中指针回退到**同组的下一个可见变体**，
 * 找不到就指向 null —— 保证激活路径永远不会指向已删除节点。
 * 不做物理删除，因此"回收站"天然可用（PRD R6）。
 *
 * 【为什么留着】界面上的删除已经改成"只删这一条"（用户明确要的语义），
 * 但"删掉这一条及其之后"仍然是个合理的动作（清掉一段试错的对话），
 * 将来加"删除后续"入口时直接用它 —— 它有用例钉着，不是死代码。
 */
export function withSoftDelete( // @dead-export-ok: 保留"删整条分支"的能力，当前界面只删单条（withNodeRemoved）
  state: TreeState,
  id: MessageId,
  now: number,
): TreeState {
  const target = state.nodes.find((n) => n.id === id);
  if (!target) return state;

  // 连同整棵子树一起软删除（级联）
  const index = buildTreeIndex(state.nodes);
  const doomed = new Set<MessageId>([id]);
  const stack: MessageId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const childId of index.childIdsOf.get(current) ?? []) {
      doomed.add(childId);
      stack.push(childId);
    }
  }

  const nodes = state.nodes.map((node) =>
    doomed.has(node.id) && node.deletedAt === null ? { ...node, deletedAt: now, updatedAt: now } : node,
  );

  let next: TreeState = { ...state, nodes };

  // 父节点的选中指针若指向被删的节点，回退到一个仍然可见的兄弟变体
  const parentId = target.parentId;
  const stillActive = activeChildOf(next, parentId);
  if (stillActive !== null && doomed.has(stillActive)) {
    /*
     * 回退目标必须**同时**满足"这次没被删"与"本来就还看得见"。
     * 只判断前者是不够的：一个更早就被删掉的兄弟会被选中，
     * 指针于是落到一条不显示的消息上 —— 用户看到的是"选中消失了"，
     * 而数据里其实指着东西，下一次渲染才暴露出来。
     */
    const fallback =
      index.childIdsOf
        .get(parentId)
        ?.map((childId) => nodes.find((n) => n.id === childId))
        .find((n): n is MessageNode => !!n && !doomed.has(n.id) && n.deletedAt === null) ?? null;
    next = setActiveChild(next, parentId, fallback ? fallback.id : null);
  }

  return next;
}

/** 当前激活路径最末端的节点 id（用于后续追加消息） */
export function activeLeafIdOf(state: TreeState): MessageId | null {
  const path = indexOf(state);
  let cursor: MessageId | null = state.activeRootChildId;
  let last: MessageId | null = null;
  const guard = new Set<MessageId>();

  while (cursor) {
    if (guard.has(cursor)) break;
    guard.add(cursor);
    const node = path.byId.get(cursor);
    if (!node || node.deletedAt !== null) break;
    last = node.id;
    cursor = node.activeChildId;
  }

  return last;
}
