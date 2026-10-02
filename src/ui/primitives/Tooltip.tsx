import clsx from 'clsx';
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

/**
 * "我正处在应用自己的提示里"
 *
 * 【为什么需要它：一个按钮**只能有一个浮层**】
 * `IconButton` 早先会把 `label` 当成原生 `title` 挂到按钮上（浏览器的慢速浮层），
 * 而调用方常常又用 `<Tooltip>` 包一层（应用的快速浮层）—— 于是鼠标一停，
 * **两个面板同时冒出来**，还是两套字。让子元素自己能问出这件事，
 * 就能保证"外面有了，里面就不再要"。
 */
const InsideTooltip = createContext(false);

/** 供原语（如 `IconButton`）判断：外层是否已经提供了应用自己的提示 */
export function useInsideTooltip(): boolean {
  return useContext(InsideTooltip);
}

type Side = 'top' | 'bottom';

interface Placement {
  left: number;
  top: number;
  side: Side;
  /** 只允许翻转一次，避免"太高的内容在上下之间来回跳" */
  flipped: boolean;
}

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: Side;
  className?: string;
}

const MARGIN = 8;

/** 会把焦点移到别的控件上的按键 —— 只有它们之后的 `focus` 才算"用户在指向某个控件" */
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** 能直接挂事件的子元素形态（原生标签；自定义组件需要它们自己转发 props） */
type HostChild = ReactElement<{
  onMouseEnter?: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
  onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
}>;

/**
 * 轻量 Tooltip（带自动翻转）
 *
 * 【怎么挂上去：能直挂就直挂，实在不行才包一层】
 * 子元素是**原生标签**（`<button>`、`<span>`…）时，把事件直接克隆到它身上 ——
 * **不插任何额外节点**。这一条很重要：列表行是 `flex: 1` 的按钮，中间插一层
 * 包裹就会把行的伸缩算坏（早先拖动手柄就吃过这个亏），于是那些行只能继续用
 * 浏览器原生的 `title`，观感与别处不一致。
 *
 * 子元素是自定义组件时退回包裹：那种组件未必把不认识的 props 转发到 DOM 上，
 * 硬克隆会让提示**静默失效**（比不统一更糟）。包裹时位置按**子元素**量，
 * 否则绝对定位的子元素会让面板飘走。
 *
 * 【位置怎么算】
 * 用 `event.currentTarget` —— 事件挂在谁身上，量出来的就是谁，
 * 不需要 ref，也不可能量错对象。面板挂到 body 上（不被父级 overflow 裁掉），
 * 渲染后实测尺寸：上方放不下就翻到下方，水平越界就夹回可视区（只翻一次，避免抖动）。
 */
/**
 * 包裹路径下"真正会被换掉的那一层"
 *
 * 包裹 span 是 Tooltip 自己插的，它一定还在；子元素被替换或卸载时消失的是里面那一层。
 */
function innerOf(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.firstElementChild instanceof HTMLElement ? wrapper.firstElementChild : null;
}

export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  /**
   * 真正承载内容的那一层（未必是 `anchorRef` 本身）
   *
   * 【为什么必须单独记一份 —— 探针量出来的事实】
   * 走"包一层"那条路径时（子元素是自定义组件），`anchorRef` 指的是**我们自己的包裹 span**：
   * 它不会随里面的子元素被替换而消失，所以只盯它，"触发元素已经没了"永远判不出来 ——
   * 实测换完子元素后包裹 span 依旧 `isConnected === true`，浮层就留在屏幕上。
   * 因此这里额外记住包裹内部的第一个元素；两条路径都填上，判断时**两个都要还在**。
   */
  const innerRef = useRef<HTMLElement | null>(null);
  /**
   * 浮板只由**两个真实动作**点亮，其余一律不点
   *
   * ```
   * 指针路径（mouseenter）：需要"指针真的动过"      → pointerDismissedRef
   * 键盘路径（focus）    ：需要"刚按过移动焦点的键"  → navKeyRef
   * ```
   *
   * 【为什么键盘路径不能用"任何按键"来判定 —— 这才是那个 bug 的根因】
   * 关闭面板时 `useModalFocus` 会把焦点**还给当初打开它的那个按钮**。
   * 于是"点开设置 → 关掉设置"这条路上，按钮会在最后拿到一次 focus；
   * 而这一次 focus 并不是用户想指向它。
   * 早先只要按过**任何**键（在面板里按 Tab、按 Esc 都算）就会放行 focus 路径，
   * 于是关掉面板的瞬间浮板又被点亮 —— 而那时指针根本不在按钮上（用户原话），
   * 正好排除了 mouseenter，也就把根因锁死在 focus 上。
   *
   * 现在只认**移动焦点的那几个键**：Tab、方向键。Esc 更相反 —— 它是"退下"，
   * 所以按 Esc 会顺手把这条路径也关掉。
   */
  const pointerDismissedRef = useRef(false);
  /** 最近一次交互是不是"移动焦点的按键"（Tab / 方向键）；ESC 与任何指针操作都会清掉它 */
  const navKeyRef = useRef(false);
  /** 正在等"指针动一下"的那个解除回调（同一时刻只挂一个，避免监听器越挂越多） */
  const releaseRef = useRef<(() => void) | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const placeAround = useCallback(
    (element: HTMLElement, inner: HTMLElement | null) => {
      anchorRef.current = element;
      innerRef.current = inner ?? element;
      const rect = element.getBoundingClientRect();
      setPlacement({
        left: rect.left + rect.width / 2,
        top: side === 'top' ? rect.top - MARGIN : rect.bottom + MARGIN,
        side,
        flipped: false,
      });
    },
    [side],
  );

  const hide = useCallback(() => {
    setPlacement(null);
    anchorRef.current = null;
    innerRef.current = null;
  }, []);

  /**
   * 收起，并要求**下一次显示必须由真实动作发起**
   *
   * 用在"点过了 / 按了 Esc / 窗口切走了"这些场合：那时指针常常还停在按钮上，
   * 而遮挡物消失时浏览器会补派一次 `mouseenter` —— 不收的话浮板就会自己回来。
   * 键盘那条路径一并关掉：Esc 是"退下"，不该马上又弹出来。
   */
  const dismiss = useCallback(() => {
    pointerDismissedRef.current = true;
    navKeyRef.current = false;
    hide();
    // 已经挂过就不再挂：多次点击只保留一个解除回调
    if (releaseRef.current) return;

    const release = () => {
      pointerDismissedRef.current = false;
      document.removeEventListener('pointermove', release, true);
      releaseRef.current = null;
    };
    releaseRef.current = release;
    /*
     * **只有指针真的移动**才解除
     *
     * 早先这里连 `keydown` 一起解除 —— 那正是 bug 的来源：在面板里按 Tab 或
     * 按 Esc 都会提前解除，紧接着面板关闭时的焦点还原就把浮板又点亮了。
     * 键盘那条路径有它自己的判据（见 navKeyRef），不需要靠这里放行。
     */
    document.addEventListener('pointermove', release, true);
  }, [hide]);

  /*
   * 常驻记录"最近一次交互是不是移动焦点的按键"
   *
   * 【为什么不能只在浮板显示期间听】它要回答的问题是"这次 focus 是不是 Tab 来的" ——
   * 而那一刻浮板通常**还没显示**（浮板正是被这次 focus 点亮的）。
   * 放进显示期的监听里，键盘用户就永远看不到提示了（这条被用例当场抓到过）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') navKeyRef.current = false;
      else if (NAV_KEYS.has(event.key)) navKeyRef.current = true;
    };
    // 一旦用了指针，键盘判据立即作废（焦点会落在被点的元素上，那不是"重新指向"）
    const onPointerDown = () => {
      navKeyRef.current = false;
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  // 卸载时把可能还挂着的解除回调摘掉（它挂在 document 上，不随组件消失）
  useEffect(
    () => () => {
      if (releaseRef.current) {
        document.removeEventListener('pointermove', releaseRef.current, true);
        releaseRef.current = null;
      }
    },
    [],
  );

  /**
   * 兜底收起：触发元素消失了 / 按了 Esc / 窗口失焦
   *
   * 【为什么"消失"要单独盯】
   * 收起本来只挂 `mouseleave`，而**元素被卸载时不会有 mouseleave** ——
   * 悬停期间列表被过滤、面板被关闭、行被重排，那个提示就会永久留在屏幕上，
   * 用户只看到一块浮着不走的字（真实遇到过）。
   * 元素的存亡没有事件可听，所以在"有面板挂着"的这一小段时间里每帧确认一次它还在不在：
   * 一个 `isConnected` 读，代价可以忽略，而且面板一收起就停了。
   *
   * Esc 与失焦是给另一种情形兜底的：鼠标停在按钮上然后 Alt+Tab 切走 ——
   * 回来时指针早已不在触发区，而提示还挂着。
   */
  useEffect(() => {
    if (!placement) return;

    /*
     * 触发元素被移除 → 收起
     *
     * 元素的存亡**没有事件可听**（卸载时不会有 `mouseleave`），但"被移除"这件事
     * 本身就是一次 DOM 变动 —— 用 MutationObserver 就够，而且它只在"有面板挂着"
     * 这段时间里存在。这里**刻意不用 rAF 轮询**：没有渲染循环的环境（jsdom）里
     * 帧回调不保证触发，而这条规则恰恰是要靠用例钉住的。
     */
    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            const anchor = anchorRef.current;
            const inner = innerRef.current;
            // 两层都要还在（包裹路径下"里面那层"才是真正的触发内容，理由见 innerRef 的注释）
            if (!anchor || !anchor.isConnected || !inner || !inner.isConnected) hide();
          })
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });

    // Esc 是"退下"：收起，并且不再让焦点把它拉回来（navKey 的维护见上面那个常驻 effect）
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };

    /*
     * 焦点转移到别处 → 收起
     *
     * 覆盖"窗口没失焦、但交互已经转移"的情形：点了另一个按钮、菜单把焦点拿走了。
     * 判据是**焦点是否还在触发元素内部** —— 键盘用户 Tab 到触发元素时就是要看提示，
     * 所以不能见到 focusin 就收。
     */
    const onFocusIn = (event: FocusEvent) => {
      const anchor = anchorRef.current;
      if (!anchor || event.composedPath().includes(anchor)) return;
      hide();
    };

    /*
     * 切到后台 → 收起
     *
     * `blur` 大多数情况够用，但它依赖窗口真的失焦；有些平台/窗口管理器只改可见性、
     * 不发 blur（用户反馈过"Alt+Tab 切走再切回来，浮窗还挂着"）。
     * `visibilitychange` 便宜且确定，两条都挂上。
     */
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') dismiss();
    };

    /*
     * 点击 → 收起，并且"等指针动一下"才允许再显示
     *
     * 监听挂在 document 的**捕获阶段**，所以点在哪里都算：触发按钮本身、刚打开的
     * 面板、面板里的空白处。这正是"目标被移除 / 弹窗打开时不会触发 mouseout，
     * 得在这些时机强制收起"这条经验的落点。
     *
     * `detail > 0` 用来区分来源：鼠标点击的 detail ≥ 1，而键盘（Enter/Space）触发的
     * click 是 0。键盘点击不该把提示"静音"—— 否则他之后 Tab 到别的按钮就再也看不到了。
     */
    const onDocumentClick = (event: MouseEvent) => {
      /*
       * `detail > 0` = 指针点击，`0` = 键盘激活（Enter/Space）。
       * 指针点击算"重新开始一次交互"（连同清掉键盘判据）；键盘激活只收起当前这一个。
       */
      if (event.detail > 0) dismiss();
      else hide();
    };

    /*
     * 滚动 → 收起
     *
     * 滚动时指针可能压根没动，而提示是按**点击那一刻的坐标**定位的（`position: fixed`）：
     * 不收起它会停在原地、与被指向的控件错位。用捕获阶段才听得到内层滚动容器。
     */
    const onScroll = () => hide();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', dismiss);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('scroll', onScroll, true);

    return () => {
      observer?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('click', onDocumentClick, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [placement, hide, dismiss]);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const anchor = anchorRef.current;
    /*
     * 位置校正时重新量一次：目标可能已经不在文档里（行被过滤掉了），
     * 那时量到的是 0，硬用会把面板夹到屏幕边缘 —— 不如保持原样。
     */
    if (!placement || !tip || !anchor || !anchor.isConnected) return;

    const { width, height } = tip.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const next: Placement = { ...placement };
    let changed = false;

    if (!placement.flipped) {
      if (placement.side === 'top' && placement.top - height < MARGIN) {
        next.side = 'bottom';
        next.top = rect.bottom + MARGIN;
        next.flipped = true;
        changed = true;
      } else if (
        placement.side === 'bottom' &&
        placement.top + height > window.innerHeight - MARGIN
      ) {
        next.side = 'top';
        next.top = rect.top - MARGIN;
        next.flipped = true;
        changed = true;
      }
    }

    const half = width / 2;
    const clampedLeft = Math.min(
      Math.max(next.left, half + MARGIN),
      window.innerWidth - half - MARGIN,
    );
    if (clampedLeft !== next.left) {
      next.left = clampedLeft;
      changed = true;
    }

    if (changed) setPlacement(next);
  }, [placement]);

  const panel = placement
    ? createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          className={styles.tip}
          data-side={placement.side}
          style={{ left: placement.left, top: placement.top }}
        >
          {label}
        </span>,
        document.body,
      )
    : null;

  /*
   * 单个原生标签：把事件克隆上去，**不插包裹**
   *
   * 原有的事件照旧调用（`Button` 之类可能自己也在用 onFocus），我们只做叠加。
   */
  if (isValidElement(children) && typeof children.type === 'string') {
    const child = children as HostChild;
    const own = child.props;

    return (
      <InsideTooltip.Provider value={true}>
        {cloneElement(child, {
          onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
            own.onMouseEnter?.(event);
            // 指针路径：刚点过就必须先真的动一下指针（见 pointerDismissedRef）
            if (pointerDismissedRef.current) return;
            // 克隆路径下 anchor 就是内容本身（事件挂在它身上），两层同一个元素
            placeAround(event.currentTarget, event.currentTarget);
          },
          onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
            own.onMouseLeave?.(event);
            hide();
          },
          onFocus: (event: React.FocusEvent<HTMLElement>) => {
            own.onFocus?.(event);
            /*
             * 键盘路径：必须"刚按过移动焦点的键"
             *
             * 这一条挡的就是那个 bug —— 关闭面板时焦点被还给这个按钮，
             * 而那不是用户想指向它（那时指针根本不在按钮上）。
             */
            if (!navKeyRef.current) return;
            placeAround(event.currentTarget, event.currentTarget);
          },
          onBlur: (event: React.FocusEvent<HTMLElement>) => {
            own.onBlur?.(event);
            hide();
          },
          /*
           * 一按下去就收起来
           *
           * 鼠标停在按钮上时提示开着；一按下去，按钮往往**弹出一个菜单/面板**，
           * 而这时指针还在按钮上 —— `mouseleave` 不会来，提示就浮在新面板旁边不走
           * （用户反馈的正是这个）。按下去表达的是"我已经知道这个按钮是干什么的了"，
           * 收起它没有任何损失；原来的 onPointerDown 照旧调用。
           */
          onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
            own.onPointerDown?.(event);
            dismiss();
          },
        })}
        {panel}
      </InsideTooltip.Provider>
    );
  }

  /*
   * 兜底：包一层
   *
   * 自定义组件不一定会把 `onMouseEnter` 转发到 DOM 上，克隆等于让提示静默失效；
   * 包一层则一定能收到事件。代价是多一个节点，所以只在必要时用。
   */
  return (
    <>
      <InsideTooltip.Provider value={true}>
        <span
          ref={wrapperRef}
          /* 触发区默认 inline-flex：这样包住按钮时不会破坏父级的 flex 布局 */
          className={clsx(styles.trigger, className)}
          onMouseEnter={(event) => {
            // 指针路径：刚点过就必须先真的动一下指针（见 pointerDismissedRef）
            if (pointerDismissedRef.current) return;
            placeAround(event.currentTarget, innerOf(event.currentTarget));
          }}
          onMouseLeave={hide}
          onFocus={(event) => {
            // 键盘路径：必须刚按过移动焦点的键（理由见 navKeyRef）
            if (!navKeyRef.current) return;
            placeAround(event.currentTarget, innerOf(event.currentTarget));
          }}
          onBlur={hide}
          /* 按下去就收起，并且在指针再动之前不许它冒回来 */
          onPointerDown={dismiss}
        >
          {children}
        </span>
      </InsideTooltip.Provider>
      {panel}
    </>
  );
}

/**
 * 说明图标
 *
 * 用途：把「一句解释」从正文里挪出来，避免设置页被大段说明文字占满。
 * 可聚焦，因此键盘用户同样能读到说明。
 */
export function HelpTip({ text }: { text: ReactNode }) {
  return (
    <Tooltip label={text} side="top" className={styles.helpTrigger}>
      <span
        className={styles.help}
        tabIndex={0}
        role="note"
        aria-label={typeof text === 'string' ? text : undefined}
      >
        ?
      </span>
    </Tooltip>
  );
}
