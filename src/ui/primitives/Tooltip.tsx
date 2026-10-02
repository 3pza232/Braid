import clsx from 'clsx';
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
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

/** 能直接挂事件的子元素形态（原生标签；自定义组件需要它们自己转发 props） */
type HostChild = ReactElement<{
  onMouseEnter?: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
  onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
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
export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const placeAround = useCallback(
    (element: HTMLElement) => {
      anchorRef.current = element;
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
  }, []);

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
            placeAround(event.currentTarget);
          },
          onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
            own.onMouseLeave?.(event);
            hide();
          },
          onFocus: (event: React.FocusEvent<HTMLElement>) => {
            own.onFocus?.(event);
            placeAround(event.currentTarget);
          },
          onBlur: (event: React.FocusEvent<HTMLElement>) => {
            own.onBlur?.(event);
            hide();
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
          onMouseEnter={(event) => placeAround(event.currentTarget)}
          onMouseLeave={hide}
          onFocus={(event) => placeAround(event.currentTarget)}
          onBlur={hide}
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
