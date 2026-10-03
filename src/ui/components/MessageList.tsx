import { useEffect, useMemo, useRef, useState } from 'react';
import { activePathOf, cachedTreeIndex, variantPosition } from '@domain/rules/messageTree';
import { resolveConfig } from '@domain/rules/resolveConfig';
import type { MessageId } from '@shared/ids';
import { IconArrowDown, IconArrowUp } from './Icons';
import { MessageItem } from './MessageItem';
import { Tooltip } from '@ui/primitives';
import { COPY_FAILED_MESSAGE, copyText } from '@ui/utils/clipboard';
import {
  clearSearchHighlight,
  paintSearchHighlights,
  revealRange,
  type SearchPaintInput,
} from '@ui/utils/searchHighlight';
// 全局样式：`::highlight()` 的名字是运行时注册的，不能放进 CSS Module
import '@ui/styles/searchHighlight.css';
import { useChatStore } from '@ui/stores/chatStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useUiStore } from '@ui/stores/uiStore';
import styles from './MessageList.module.css';

/** 距底多少像素以内算"贴在底部"：太小时轻微抖动就会判定为脱开 */
const STICK_THRESHOLD_PX = 48;

/**
 * 复制到剪贴板
 *
 * 定义在模块级而不是写成内联箭头函数：内联的话每次渲染都是新引用，
 * 会让 `MessageItem` 的 `memo` 每次都判定"props 变了"，记忆化就白做了。
 */
const copyToClipboard = (text: string): void => {
  /*
   * 成功不打扰（粘一下就知道了），失败必须说
   *
   * `navigator.clipboard` 在非安全上下文下是 `undefined`，权限被拒时会 reject ——
   * 早先一句 `void navigator.clipboard?.writeText(text)` 把两种都吞了，
   * 用户看到的就是"点了复制没反应"。
   */
  void copyText(text).then((copied) => {
    if (copied) return;
    useUiStore.getState().pushNotice({ tone: 'error', message: COPY_FAILED_MESSAGE });
  });
};

/**
 * 消息区
 *
 * 渲染的是**真实的消息树**：从 store 取节点集合，用 `@domain/rules` 的
 * `buildTreeIndex` + `activePathOf` 算出当前激活路径，再把每个节点交给 MessageItem。
 *
 * 【自动跟随滚动】
 * 内容变长时自动贴住底部，但**用户手动往上翻就松开**，翻回底部又自动贴上。
 * 实现用 `ResizeObserver` 观察内容高度，而不是监听消息文本长度：
 * 因为"内容变高"的来源不止正文 —— 思考链路展开/收起、图片加载、字体变化都会改变高度，
 * 逐一声明这些触发条件既啰嗦又必然漏掉。观察高度是唯一不会漏的做法。
 */
export function MessageList() {
  const nodes = useChatStore((s) => s.tree.nodes);
  const activeRootChildId = useChatStore((s) => s.tree.activeRootChildId);
  const conversation = useChatStore((s) => s.conversation);
  const activeId = useChatStore((s) => s.activeId);
  const editMessage = useChatStore((s) => s.editMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const continueWriting = useChatStore((s) => s.continueWriting);
  const continuableMessageId = useChatStore((s) => s.continuableMessageId);
  const streamPhase = useChatStore((s) => s.streamPhase);
  const selectVariant = useChatStore((s) => s.selectVariant);
  const locate = useChatStore((s) => s.locate);
  const searchHits = useChatStore((s) => s.searchHits);
  const searchQuery = useChatStore((s) => s.searchQuery);

  const settings = useSettingsStore((s) => s.settings);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  /** 当前是否"贴在底部"；用户手动上滚会把它置为 false */
  const stickRef = useRef(true);
  /**
   * 我们自己上一次把滚动条放到的位置
   *
   * 用来把**程序滚动**与**用户滚动**区分开，这个区分是必须的：
   * `scrollTop = scrollHeight` 会**异步**派发一个 scroll 事件，而流式输出时
   * 事件真正派发的那一刻内容往往又长高了一截 —— 此时读到的
   * `scrollHeight - scrollTop - clientHeight` 是个偏大的值，
   * 于是被误判成"用户往上翻了"，自动跟随就此停住。
   * 表现就是用户看到的"思考过程滚到一半突然不动了"。
   *
   * 判断依据是**我们设过的值**：位置与它一致 = 不是用户滚的，直接忽略；
   * 不一致 = 用户真的动了滚动条，再按实际距离判断。
   */
  const pinnedTopRef = useRef(-1);

  /**
   * 贴到底，并记下"这是我们自己干的"
   *
   * 【为什么要读回 scrollTop】
   * `scrollTop` 会被浏览器**钳**在 `scrollHeight − clientHeight` 以内，而
   * `scrollHeight` 本身不是合法值。早先的写法是把 `scrollHeight` 存进
   * pinnedTopRef —— 于是"这次滚动是我们发的"永远判不出来（两者差着正好一个
   * clientHeight）。后果是：流式内容一长高，我们自己那次滚动就被当成
   * "用户往上翻了"，自动跟随毫无征兆地停住。
   * 赋值后读回真实值，这个判断才成立。
   */
  const pinBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    pinnedTopRef.current = scroller.scrollTop;
  };

  // useMemo 很关键：索引与路径都是新对象，不能在 selector 里现算（会触发无限重渲染）
  // 缓存版：同一棵树（消息树是不可变的）重复渲染只建一次索引 ——
  // 与顶栏用量、上下文闸门共用同一份，见 domain/rules/messageTree.ts
  const index = cachedTreeIndex(nodes);
  const path = useMemo(() => activePathOf(index, activeRootChildId), [index, activeRootChildId]);
  const config = useMemo(() => resolveConfig(settings, conversation), [settings, conversation]);

  /*
   * 【"要不要跟随"与"按钮能不能点"是两件事，早先它们被混成一个变量】
   *
   *  `stickRef`         —— 要不要自动跟随。阈值**宽**（48px 内都算贴底），
   *                        因为轻微抖动不该让跟随断掉；
   *  `atTop`/`atBottom` —— 两颗按钮是否置灰。阈值**紧**（±2px），
   *                        它们回答的是"还能不能再往那边滚"。
   *
   * 两者共用一个 48px 阈值时会出现这样一幕：内容只溢出 30px 时，
   * `atTop` 与 `atBottom` **同时**为真 —— 两颗按钮全灰，而内容明明还能滚。
   * 这就是用户看到的"这两个按钮基本没用"。
   *
   * 另外这两个按钮**常显**，不再按"内容是否溢出"来挂卸 ——
   * 那个判断一旦写错（把"还能滚多远"当成"是否溢出"），按钮就会在滚到底时
   * 凭空消失。可用状态交给 `disabled` 表达，比控制挂载更不容易出错。
   */
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  /**
   * 回到最上面
   *
   * 顺手**松开自动跟随**：回到顶部意味着用户要读历史，若还贴着底部，
   * 下一段流式输出会立刻把他拽回最下面 —— 那一下比没有这个按钮更让人恼火。
   */
  const scrollToTop = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stickRef.current = false;
    /*
     * 两颗按钮都用**瞬时**滚动
     *
     * 这里本来对"回到最上"用了 smooth，那是错的：滚动动画期间每一帧都在改
     * scrollTop，而我们的 scroll 监听又在实时判断"现在到哪了"，两者互相干扰 ——
     * 动画途中按钮的亮灭会来回跳，流式输出一长高更是直接把动画打断在半路，
     * 表现就是"点了滑一半又弹回去"。
     * 这两个按钮的语义都是"立刻带我到那里"，瞬间到位才是它们该有的行为。
     */
    scroller.scrollTop = 0;
    pinnedTopRef.current = 0;
    setAtTop(true);
    setAtBottom(false);
  };

  /**
   * 回到最新
   *
   * 同样用直接跳：流式输出期间内容每 120ms 就长高一次，
   * 平滑动画根本追不上目标。
   */
  const scrollToBottom = () => {
    stickRef.current = true;
    // 贴底 + 读回被钳过的真实值（理由见 pinBottom）
    pinBottom();
    setAtBottom(true);
    setAtTop(false);
  };

  /**
   * 跳到某条消息的顶部或底部
   *
   * 【为什么要走 rect 差值，而不是 offsetTop】
   * `offsetTop` 相对的是**最近的定位祖先**，不一定是这个滚动容器；消息外面还套着
   * 网格与列容器，一旦哪层的 position 变了，算出来的位置就会整体偏移。
   * 两个 rect 相减得到的是"目标相对视口的位置"，与布局层次无关。
   *
   * 【为什么要写 pinnedTopRef】
   * 滚动事件是异步派发的，而 `onScroll` 靠"位置是否等于我们设过的值"来区分
   * 自己人与用户（见它的说明）。不记这一笔，这次跳转会被当成"用户往上翻了"，
   * 当场掐断自动跟随 —— 而从底部跳回某条消息的顶部，用户多半只是想读一读。
   */
  const jumpToMessage = (id: MessageId, edge: 'top' | 'bottom') => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const element = scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!element) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const delta = edge === 'top' ? rect.top - scrollerRect.top : rect.bottom - scrollerRect.bottom;

    scroller.scrollTop += delta;
    // 读回被钳过的真实值（理由同 pinBottom）
    pinnedTopRef.current = scroller.scrollTop;

    /*
     * 跟随意图按**落点**重新判断，而不是一律停掉
     *
     * 跳到顶部多半是要停下来读 → 不该再被新内容拽回底部；
     * 但如果本来就是最后一条、跳完仍然贴着底（比如它比一屏还短），
     * 那就该继续跟随 —— 判据与 `onScroll` 里那条完全一致。
     */
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickRef.current = remaining <= STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const scroller = scrollerRef.current;
    const column = columnRef.current;
    if (!scroller || !column) return;

    /**
     * 与滚动位置有关的界面状态
     *
     * 不管这次滚动是谁发起的，"上下还有没有内容"都是同一个事实，
     * 所以它独立于下面的分支，每次滚动都重算。
     */
    const syncScrollState = () => {
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      // 紧阈值：回答的是"还能不能再滚"，与"想不想跟随"是两件事
      setAtTop(scroller.scrollTop <= 2);
      setAtBottom(remaining <= 2);
    };

    const onScroll = () => {
      /*
       * 只有**用户自己**的滚动才改变跟随意图
       *
       * 我们贴底那一下也会派发 scroll 事件（而且是异步派发的），
       * 那时内容往往又长高了一截、算出来的距离偏大，
       * 不排除掉就会把自己人干的活当成"用户往上翻了"，跟随当场断掉。
       * 判据是位置是否等于我们设过的值（见 pinnedTopRef 的说明）。
       */
      const echo = Math.abs(scroller.scrollTop - pinnedTopRef.current) < 1;
      if (!echo) {
        const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        stickRef.current = remaining <= STICK_THRESHOLD_PX;
      }
      syncScrollState();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });

    /*
     * 观察内容高度，而不是"文本变长了"
     *
     * 内容变高的来源不止正文：思考链展开/收起、代码块高亮、图片加载、
     * 字体与密度变化……逐一声明这些触发条件既啰嗦又必然漏掉，
     * 观察高度是唯一不会漏的做法。
     */
    const observer = new ResizeObserver(() => {
      if (stickRef.current) pinBottom();
      syncScrollState();
    });
    observer.observe(column);

    // 首屏先算一次：内容不够长时两个按钮都不该出现
    syncScrollState();

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, []);

  // 切换会话时直接跳到最新，而不是沿用上一个会话的滚动位置
  useEffect(() => {
    stickRef.current = true;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    // 读回**钳过的真实值**（理由见 pinToBottom）：否则切换会话后第一个
    // scroll 事件会被误判成"用户往上翻"，跟随当场失效
    pinnedTopRef.current = scroller.scrollTop;
    setAtBottom(true);
    setAtTop(false);
    // 高亮是全局注册的，换会话时必须清掉：上一次的区间指向已经卸载的节点，
    // 留着不会报错，但会在同一段文字上留下"没有来源的高亮"
    clearSearchHighlight();
  }, [activeId]);

  /**
   * 发送之后**一定**回到最下面
   *
   * 【为什么不能只靠 ResizeObserver】
   * 用户往上翻着读历史时，自动跟随会松开（这是对的，否则新内容会把他拽走）。
   * 但"松开"不该一直生效：他接着在输入框里打字并**发送**，那条消息就落在
   * 视口之外 —— 点了发送却停在半空，看谁都像是没发出去。
   * 所以这里补一条规则：**刚发出去的那条必须看得见**。
   *
   * 判据是"激活路径的最后一条变成了用户消息"：这恰好等于"刚刚按下发送"，
   * 而流式输出（最后一条是正在写的回复）与翻看历史都不会误触发。
   */
  const lastNode = path.length > 0 ? path[path.length - 1] : null;
  const lastNodeId = lastNode?.id ?? null;
  const lastIsUser = lastNode?.role === 'user';

  useEffect(() => {
    if (!lastIsUser) return;
    stickRef.current = true;
    pinBottom();
    setAtBottom(true);
    setAtTop(false);
  }, [lastNodeId, lastIsUser]);

  /** 已经定位过的目标：同一次定位只做一遍，避免流式期间反复把视口拽走 */
  const locatedKeyRef = useRef<string | null>(null);

  /**
   * 搜索命中定位：**滚动**过去
   *
   * 依赖里带 `path.length` 是必须的：点搜索结果是**先切会话、再定位**，
   * 而切会话是异步加载消息树的 —— effect 第一次跑时树还是空的，
   * `querySelector` 什么也找不到。等消息到位后再试一次。
   * 用长度而不是 `path` 本身：后者每帧都是新数组，会让这个 effect
   * 跟着流式输出的节奏反复重跑。
   *
   * 高亮**不在这里画**：那是"当前状态 → 画面"的映射，由下面的绘制 effect
   * 单独负责。混在一起会出现"滚动过去了但底色还是上一次的"。
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!locate) {
      locatedKeyRef.current = null;
      return;
    }
    if (!scroller) return;
    if (locatedKeyRef.current === locate.messageId) return;

    const target = scroller.querySelector<HTMLElement>(`[data-message-id="${locate.messageId}"]`);
    if (!target) return; // 会话刚切过来、消息树还在加载：等 `path.length` 变化后重试

    locatedKeyRef.current = locate.messageId;
    /*
     * 定位到历史位置就**松开自动跟随**
     * 不松的话，下一段流式输出会立刻把视口拽回最下面 ——
     * 用户刚看到的那处高亮一闪而过，等于没定位。
     */
    stickRef.current = false;
    // 先把**消息**滚出来（词级精确定位交给下面画高亮时的 revealRange）
    target.scrollIntoView({ block: 'center' });
  }, [locate, path.length]);

  /**
   * 高亮绘制的"最新输入"
   *
   * DOM 会不停地变（流式输出重渲染、思考过程展开/收起、变体切换……），
   * 每一次都可能让上一次画好的区间指向已经不在文档里的文字节点。
   * 所以把输入存一份，DOM 一变就用**同一份输入**重画。
   */
  const paintRef = useRef<SearchPaintInput | null>(null);

  /**
   * 还要不要把当前那一处滚进视野
   *
   * 一次跳转可能要等 DOM 变过之后才滚得动：命中藏在折叠的思考过程里时，
   * 展开之前那段文字根本不存在，第一次绘制拿不到区间。
   * 所以这个标记不是"滚过了就清掉"，而是"**滚成功之后**才清掉"——
   * 没成功就留给 DOM 变化后的那次重绘去补。
   */
  const pendingRevealRef = useRef(false);

  const repaint = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const input = paintRef.current;
    if (!input) {
      clearSearchHighlight();
      return;
    }

    const range = paintSearchHighlights(scroller, input);
    if (!range || !pendingRevealRef.current) return;

    pendingRevealRef.current = false;
    revealRange(range, scroller);
    // 这是我们自己滚的：记下位置，免得被当成"用户往上翻"而掐断自动跟随
    pinnedTopRef.current = scroller.scrollTop;
  };

  // 搜索状态一变就重算输入并立刻画一次
  useEffect(() => {
    if (searchHits.length === 0 || searchQuery.length === 0) {
      paintRef.current = null;
    } else {
      paintRef.current = {
        query: searchQuery,
        /*
         * 全部命中的消息 id（可能跨会话）
         *
         * 不在当前会话里的那些查不到 DOM 元素，绘制时会自然跳过 ——
         * 不必在这里先筛一遍会话，多一道判断只是多一个会忘的地方。
         */
        messageIds: searchHits.map((hit) => hit.messageId),
        current: locate
          ? { messageId: locate.messageId, occurrence: locate.occurrence }
          : null,
      };
    }

    /*
     * 换了目标（或首次搜出结果）→ 这一轮要把那一处**词**滚进视野。
     * 还没渲染出来的情况由上面的 pendingRevealRef 留着，等 DOM 变化后补。
     */
    pendingRevealRef.current = paintRef.current !== null;
    repaint();
  }, [searchHits, searchQuery, locate, activeId, path.length]);

  /**
   * DOM 一变就重画（只在有命中时才装监听）
   *
   * 需要它的场景都是真实会发生的：思考过程展开、流式输出替换整段正文、
   * 变体切换……高亮挂在文本节点上，节点一换就作废。
   * 没有它就会出现"高亮偶尔消失、重新点一下又回来"这种说不清的现象。
   *
   * 用 rAF 合并同一帧里的多次变动：一次重画要遍历整棵可见消息树，
   * 流式输出期间 DOM 变动很密集，逐次重画是白烧 CPU。
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || searchHits.length === 0) return;

    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        repaint();
      });
    });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [searchHits.length]);

  // 卸载时清掉高亮：它注册在全局，不清会跨会话残留
  useEffect(() => clearSearchHighlight, []);

  return (
    <div className={styles.scroller} ref={scrollerRef}>
      <div
        className={styles.column}
        ref={columnRef}
        style={{ maxWidth: settings.appearance.contentMaxWidth }}
      >
        {path.length === 0 ? (
          <p className={styles.empty}>这个会话还没有消息，在下面输入框开始吧。</p>
        ) : (
          <div className={styles.divider}>
            <span className={styles.dividerLine} />
            <span className={styles.dividerLabel}>本次会话</span>
            <span className={styles.dividerLine} />
          </div>
        )}

        {path.map((node) => {
          // 传**两个数字**而不是对象：对象每次都是新引用，会废掉子组件的 memo
          const variant = variantPosition(index, node);
          return (
            <MessageItem
              key={node.id}
              node={node}
              display={settings.messageDisplay}
              appearance={settings.appearance}
              identity={config.identity}
              variantPosition={variant.position}
              variantTotal={variant.total}
              /*
               * 只有"当前命中落在思考过程里"的那一条需要自动展开。
               * 传布尔而不是把 locate 整个传下去：布尔是稳定的原始值，
               * 其余消息的 props 不变，memo 就不会把它们一起重渲染。
               */
              autoExpandReasoning={locate?.messageId === node.id && locate.reasoningOnly}
              onEdit={editMessage}
              onDelete={deleteMessage}
              onRegenerate={regenerate}
              onSelectVariant={selectVariant}
              onCopy={copyToClipboard}
              onContinue={continueWriting}
              onJumpTo={jumpToMessage}
              /*
               * 传布尔而不是把 id 整个传下去：这是原始值，其余消息的 props 不变，
               * 它们的 memo 不会被这一个按钮废掉（同 autoExpandReasoning 的理由）
               */
              canContinue={continuableMessageId === node.id}
              /*
               * 只有正在生成的那一条关心阶段，其余一律给 null
               *
               * 阶段一变就重渲染是应该的；但若把同一个值传给所有消息，
               * 它的每次变化都会让整列的 `memo` 判为"props 变了" —— 白白重渲染一屏。
               * 判据用消息自己的 `status`：它就是"这一条在不在生成"，
               * 与组件内部那条规则同一个来源，不必再比对 id。
               */
              streamPhase={node.status === 'streaming' ? streamPhase : null}
            />
          );
        })}
      </div>

      {/*
        滚动锚点
        放在滚动容器的**末尾**并用 sticky 钉在视口底部：这样它不占用布局高度
        （height: 0 + 绝对定位的按钮），不会在最后一条消息下面多出一条空带，
        又不会随内容滚走。**常显**：到两端只是置灰，不隐藏 ——
        按钮忽隐忽现比一直灰着更让人困惑。
      */}
      <div className={styles.jump}>
        {/* 提示统一走应用自己的浮层（原生 title 是另一套观感，见 primitives/Tooltip） */}
        <Tooltip label="回到最上面">
          <button
            type="button"
            className={`${styles.jumpBtn} ${styles.jumpUp}`}
            onClick={scrollToTop}
            disabled={atTop}
            aria-label="回到最上面"
          >
            <IconArrowUp size={14} />
          </button>
        </Tooltip>
        <Tooltip label="回到最新">
          <button
            type="button"
            className={`${styles.jumpBtn} ${styles.jumpDown}`}
            onClick={scrollToBottom}
            disabled={atBottom}
            aria-label="回到最新"
          >
            <IconArrowDown size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
