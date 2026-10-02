/**
 * 搜索命中的高亮
 *
 * 【为什么是 CSS Custom Highlight API，而不是往 DOM 里插 `<mark>`】
 * 插节点是最直觉的做法，但它会**与 React 的 DOM 管理直接打架**：
 * React 记着自己渲染了哪些节点，我们插进去的节点它不知道；下一次重渲染
 * （流式输出每 120ms 就有一次）它去移除/替换子节点时就会抛
 * `NotFoundError: The node to be removed is not a child of this node`。
 * 那种错误只在特定时序下出现，极难复现也极难查。
 *
 * Custom Highlight API 高亮的是**文本区间**，DOM 一个节点都不动 ——
 * 正好绕开这个冲突。代价是它只在较新的 Chromium 里有，
 * 所以下面所有入口都有回退：拿不到 API 就什么都不做（滚动定位照常生效）。
 */

/** 普通命中：淡底，用来"看见这里还有别的命中" */
const NORMAL_NAME = 'braid-search';
/** 当前聚焦的那一处：实底 + 反色，用来"看见这次跳到了哪" */
const CURRENT_NAME = 'braid-search-current';

interface HighlightLike {
  add(range: Range): void;
}

type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return css?.highlights ?? null;
}

export interface SearchPaintInput {
  /** 产生这批命中的查询词（不是输入框里的实时值） */
  query: string;
  /** 命中所在的消息 id（只传当前会话里的，别的会话不在 DOM 里） */
  messageIds: readonly string[];
  /** 当前聚焦的**那一处词**；为空表示"都按普通命中画" */
  current: { messageId: string; occurrence: number } | null;
}

/**
 * 重画高亮
 *
 * 每处命中都要画，而不是只画当前这一处 —— 用户需要知道"这一段里还有别的地方"。
 * 两类高亮的区间**互不重叠**：当前那一处只进 `current`，
 * 其余只进 `normal`。重叠时浏览器按样式表顺序决定谁显示，
 * 那种"谁盖谁"的规则在不同版本里并不稳定，不如从源头避免。
 */
export function paintSearchHighlights(
  root: HTMLElement,
  input: SearchPaintInput,
): Range | null {
  clearSearchHighlight();

  const store = registry();
  const HighlightImpl = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  const needle = input.query.trim().toLowerCase();
  if (!store || !HighlightImpl || needle.length === 0) return null;

  /*
   * 先按一次性遍历建立 id → 元素 的索引
   *
   * 直接对每处命中做 `querySelector` 也能写，但那是"命中数 × 子树规模"的扫描 ——
   * 上限 100 处命中时，长会话里每次重画都要扫一百遍。
   */
  const byId = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = element.dataset.messageId;
    if (id) byId.set(id, element);
  }

  const normal: Range[] = [];
  const current: Range[] = [];
  /** 当前聚焦的那一处区间：调用方拿它去"把词滚进视野" */
  let currentRange: Range | null = null;

  // 同一条消息会有多处理命中（每处一条记录），去重后再收集，否则区间会被画两遍
  for (const messageId of new Set(input.messageIds)) {
    const element = byId.get(messageId);
    if (!element) continue;

    const ranges: Range[] = [];
    collectRanges(element, needle, ranges);

    /*
     * 强调**只给当前那一个词**
     *
     * 这一条消息里的第 `occurrence` 个区间进 `current`，其余进 `normal` ——
     * 整条消息一起变色等于没说"这次跳到了哪"。
     */
    const focus = input.current?.messageId === messageId ? input.current.occurrence : -1;
    ranges.forEach((range, index) => {
      if (index === focus) {
        current.push(range);
        currentRange = range;
      } else {
        normal.push(range);
      }
    });
  }

  if (normal.length > 0) store.set(NORMAL_NAME, new HighlightImpl(...normal));
  if (current.length > 0) store.set(CURRENT_NAME, new HighlightImpl(...current));
  return currentRange;
}

/**
 * 把某个文本区间滚进视野
 *
 * 【为什么不用 `element.scrollIntoView()`】
 * 它只认元素，而我们要滚的是**词**。用元素顶替的后果是实打实的：
 * 命中藏在折叠的思考过程里时，展开动作会把正文往下推，
 * 等布局稳定后那个词已经跑到屏幕外了 —— 用户看到的就是"滚过去了个寂寞"。
 *
 * 【为什么要分两级对齐，以及为什么顺序是"先框后词"】
 * 词可能同时位于两层滚动容器里：思考过程面板（`max-height` + 内部滚动条）
 * 和消息区。两层的**对齐对象**不一样：
 *
 *   内层 —— 把**词**对齐到面板中间（这层要回答"在这个框里看哪一句"）；
 *   外层 —— 把**面板这个框**对齐到可视区中间（这层要回答"看哪个框"）。
 *
 * 反过来（外层也对齐"词"）会让面板的上下半截被推出屏幕：面板有 320px 高，
 * 词在它正中，一旦可视区不够高，框的上缘就跑到了可视区外 ——
 * 看到的就成了"结果贴在框外面/上面"。先立框、再立词，两级都落在各自容器的
 * 中间，读起来才是完整的上下文。
 *
 * 逐层都取**当次实测**的位置：内层滚动会改变外层的坐标，
 * 用滚动前的旧值去算外层，必然偏。
 */
export function revealRange(range: Range, boundary: HTMLElement): void {
  const layers = scrollableAncestors(range, boundary);
  if (layers.length === 0) return;

  // 从最内层往外走：内层对齐"词"，外层对齐"它里面那一层容器"
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const inner = layers[index + 1];
    const rect = inner ? inner.getBoundingClientRect() : range.getBoundingClientRect();
    const box = layer.getBoundingClientRect();
    const delta = rect.top + rect.height / 2 - (box.top + box.height / 2);
    // 已经在这一层的中间附近就不折腾了，避免把用户的滚动位置拽来拽去
    if (Math.abs(delta) > 8) layer.scrollTop += delta;
  }
}

/** 从词到 `boundary`（含）之间的可滚动祖先，**由外到内**排列 */
function scrollableAncestors(range: Range, boundary: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];

  let element =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement;

  while (element && element !== boundary.parentElement) {
    if (element.scrollHeight - element.clientHeight > 1) chain.push(element);
    element = element.parentElement;
  }

  return chain.reverse();
}

export function clearSearchHighlight(): void {
  const store = registry();
  store?.delete(NORMAL_NAME);
  store?.delete(CURRENT_NAME);
}

/**
 * 在 `root` 子树里找出全部命中，产出文本区间
 *
 * 大小写不敏感，与数据库那边的搜索口径一致 ——
 * 搜 `React` 却不高亮 `react`，用户会以为搜错了。
 */
function collectRanges(root: HTMLElement, needle: string, out: Range[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const value = textNode.nodeValue ?? '';
    if (value.length === 0) continue;

    const lower = value.toLowerCase();
    let from = lower.indexOf(needle);
    while (from >= 0) {
      const range = document.createRange();
      range.setStart(textNode, from);
      range.setEnd(textNode, from + needle.length);
      out.push(range);
      from = lower.indexOf(needle, from + needle.length);
    }
  }
}
