import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

/**
 * 列表拖动排序（id 式）
 *
 * 【为什么按 id 而不是按下标】
 * 下标是"渲染出来的位置"，它随时可能因为搜索过滤、折叠而变化；id 是稳定的身份。
 * 三处调用方（侧栏会话、侧栏角色、角色面板列表）的列表都可能被过滤，
 * 用下标会在"列表变了"的时候把错误的项挪走。
 *
 * 【为什么把算法抽成纯函数】
 * 拖动逻辑真正的风险不是 DOM 事件，而是"挪完之后顺序对不对"——
 * 尤其 from < to 时（移除元素会让后面的下标整体前移）。那是纯计算，
 * 抽出来就能直接单测，不必去模拟拖拽事件。
 *
 * 【接线：手柄 + 列表容器】
 * `handleProps` 挂到手柄上（拖动起点、键盘路径），`listProps` 挂到**列表容器**上
 * （投放判定）。两个都要挂：只挂手柄的话，"在最后一行下方松手"这一下没有目标，
 * 会被整个忽略 —— 而那正是这个交互里最常见的动作之一。
 *
 * 注：`MetaFieldList` 里还有一套更早的**下标式**内联实现（同一交互），目前仍在用。
 * 没有并进来是有意的：那边的排序语义在领域层（`reorderMetaFields`，有单测钉着），
 * 换成本 hook 就得让那个领域函数和它的用例一起消失，而**用户可见行为没有任何变化** ——
 * 为"少一个实现"付这份代价不划算。真要统一，先把两者合并成一个领域函数再迁。
 */

/** 把 `draggingId` 挪到 `overId` 所在的位置（其余项依次让位） */
export function moveIdTo<T extends string>(
  ids: readonly T[],
  draggingId: T,
  overId: T,
): T[] {
  const from = ids.indexOf(draggingId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...ids];

  const next = [...ids];
  next.splice(from, 1);
  // 先移除再插入：`to` 是**原数组**里的位置，移除后它前面少了一项，
  // 于是"插到 to"正好等于"占用目标项原来的位置"—— 这正是拖动的手感
  next.splice(to, 0, draggingId);
  return next;
}

/** 键盘移动：`delta` 为 -1 / +1（越界时原样返回） */
export function moveIdBy<T extends string>(ids: readonly T[], id: T, delta: number): T[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];

  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * 行元素的标记属性
 *
 * 调用方在**每一行**上写 `data-drag-id={id}`（三个列表都这么写），容器靠它把行量出来。
 * 为什么不按"容器的第 n 个孩子"来推：那种对应关系是隐式的 ——
 * 谁往列表里加一个表头或空态元素，落点就整体错一位，而且**不报错**。
 */
export const DRAG_ROW_ATTR = 'data-drag-id';

/** 一行的纵向范围（只关心纵向：拖动只在上下方向上有意义） */
export interface RowRect {
  id: string;
  top: number;
  bottom: number;
}

/**
 * 指针停在 `y` 处松手时，应当落到哪个 id 上
 *
 * 【为什么判定要放在容器上】
 * 指针**可能不在任何一行上**。列表底部通常留着一片空白（三处列表的 `.list`
 * 都是 `flex: 1`，内容不足时底部全空），而"把一项往下拖、在最后一行**下面**松手"
 * 正是这类列表里最常见的动作 —— 早先那一下完全没有目标（那一带没有任何元素挂
 * dragover/drop），表现为"拖到底了、松手却没动"。
 *
 * 落在某一行里 → 就用那一行；落在行外（行之间的缝隙、列表首尾之外的空白）
 * 则取**纵向最近**的一行 —— 于是"拖到最后一行下方松手"自然落到最后一项，
 * 而"停在两行之间的缝隙里"也不会突然跳到列表末尾。
 */
export function dropTargetFor(rows: readonly RowRect[], y: number): string | null {
  let best: RowRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    // 落在行里：直接命中（沿用"占用目标项位置"的既有手感）
    if (y >= row.top && y <= row.bottom) return row.id;

    /*
     * 落在行外（行之间那道几像素的缝隙、或列表首尾之外的空白）：取**纵向最近**的一行
     *
     * 这里不能写成"在最后一行之后 → 最后一项，否则 → 第一项"：
     * 那样一来，指针恰好停在两行之间的缝隙里时，落点会**跳到列表末尾** ——
     * 一行里真正会发生的事（拖动过程中指针必然扫过每一道缝隙）。
     * 距离相等时先出现的胜出，所以缝隙正中仍归上方那一行，不会来回跳。
     */
    const distance = y < row.top ? row.top - y : y - row.bottom;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }

  return best?.id ?? null;
}

/** 量出容器里每一行的纵向范围（DOM 顺序 = 视觉顺序） */
function rowRectsOf(container: HTMLElement): RowRect[] {
  const rows: RowRect[] = [];
  for (const node of container.querySelectorAll<HTMLElement>(`[${DRAG_ROW_ATTR}]`)) {
    const id = node.getAttribute(DRAG_ROW_ATTR);
    if (!id) continue;
    const box = node.getBoundingClientRect();
    rows.push({ id, top: box.top, bottom: box.bottom });
  }
  return rows;
}

export interface DragHandleProps {
  draggable: true;
  tabIndex: 0;
  role: 'button';
  'aria-label': string;
  title: string;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * 挂在**列表容器**上的属性（不是挂在手柄或行上）
 *
 * 判定只有这一处：行高、间距、滚动、有没有空态元素，都不影响正确性。
 */
export interface DragListProps {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface DragReorder<T extends string = string> {
  /** 正在被拖的 id（用于给它半透明之类的反馈） */
  draggingId: string | null;
  /** 当前悬停到的 id（用于画插入位置） */
  overId: string | null;
  /** 挂到"手柄"上的属性（不挂在整行上：行本身还要响应点击与双击重命名） */
  handleProps: (id: T, label: string) => DragHandleProps;
  /** 挂到**列表容器**上的属性；不挂上去的话整条拖动就是坏的（拖了没反应） */
  listProps: DragListProps;
}

/**
 * `T` 是 id 的类型（`ConversationId` / `RoleId` 都是品牌类型）
 *
 * 泛型不是为了好看：服务的 `reorder(orderedIds: RoleId[])` 不接受 `string[]`，
 * 用裸 string 会让类型在接线处对不上，只能靠断言硬塞 —— 那正好是这类品牌类型
 * 要防的事。
 */
export function useDragReorder<T extends string>(
  ids: readonly T[],
  onReorder: (next: T[]) => void,
): DragReorder<T> {
  /** 拖动来源记在 ref 里：`dataTransfer` 在测试环境里不完整，界面逻辑不该依赖它 */
  const draggingRef = useRef<T | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const stop = () => {
    draggingRef.current = null;
    setDraggingId(null);
    setOverId(null);
  };

  const commit = (next: T[]) => {
    // 顺序没变就不必往服务层跑一趟
    if (next.length === ids.length && next.every((id, index) => id === ids[index])) return;
    onReorder(next);
  };

  const handleProps = (id: T, label: string): DragHandleProps => ({
    draggable: true,
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    title: '按住拖动调整顺序（键盘：Alt + ↑/↓）',

    onDragStart: (event) => {
      draggingRef.current = id;
      setDraggingId(id);
      const data = event.dataTransfer;
      if (data) {
        data.effectAllowed = 'move';
        // 部分浏览器不设置数据就完全不派发 drag 事件
        data.setData('text/plain', id);
      }
    },

    onDragEnd: stop,

    onKeyDown: (event) => {
      // 拖拽对只用键盘的人不可用，而这是功能而非装饰 —— 所以也给一条键盘路径。
      // 用 Alt 组合键是为了不抢走列表里的上下键（滚动/切换焦点）。
      if (!event.altKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      commit(moveIdBy(ids, id, event.key === 'ArrowUp' ? -1 : 1));
    },
  });

  /*
   * 投放判定在**容器**上：一次算准"该落到哪一项"，落点包括最后一行下方的空白
   *
   * `overId` 也跟着这条规则走，所以悬停在下方空白时，最后一行会亮起插入线 ——
   * 用户松手前就能看到"会放到最下面"，而不是靠猜。
   */
  /**
   * 量出指针位置对应的落点 id（**并确认它现在真的还在列表里**）
   *
   * 第二件事不是多余的：DOM 里读到的是字符串，品牌的 `T` 在运行时没有痕迹；
   * 而拖动过程中列表可能被改（过滤、删除）—— 用一个已经不在列表里的 id 去算
   * 顺序，`moveIdTo` 会原样返回（无害），但返回一个"当前的 `T`"更准确。
   */
  const targetAt = (event: DragEvent<HTMLElement>): T | null => {
    const target = dropTargetFor(rowRectsOf(event.currentTarget), event.clientY);
    if (target === null) return null;
    return ids.find((id) => id === target) ?? null;
  };

  const listProps: DragListProps = {
    onDragOver: (event) => {
      // 不是本列表在拖（例如别处拖来的文件）：不参与，也不阻止默认行为
      if (draggingRef.current === null) return;
      event.preventDefault(); // 不阻止默认行为就不会触发 drop
      const data = event.dataTransfer;
      if (data) data.dropEffect = 'move';
      const target = targetAt(event);
      if (target !== null) setOverId(target);
    },

    onDrop: (event) => {
      event.preventDefault();
      const dragging = draggingRef.current;
      if (dragging !== null) {
        const target = targetAt(event);
        if (target !== null) commit(moveIdTo(ids, dragging, target));
      }
      stop();
    },
  };

  return { draggingId, overId, handleProps, listProps };
}
