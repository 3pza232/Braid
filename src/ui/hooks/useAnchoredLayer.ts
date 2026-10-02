import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

/** 浮层相对视口的位置：`top` 与 `bottom` 只会有一个（决定往下展开还是翻上去） */
export interface LayerAnchor {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /** 左对齐时给出的宽度（右对齐时由浮层自己的样式决定） */
  width?: number;
}

export interface AnchoredLayerOptions {
  /** 与触发元素对齐的一侧 */
  align?: 'left' | 'right';
  /** 与触发元素之间的间距（像素） */
  gap?: number;
  /** 左对齐时的最小宽度：比触发元素还窄的浮层很难看 */
  minWidth?: number;
  /**
   * 估算高度，用于判断"下方放不放得下"
   *
   * 用估算而不是先渲染再量：少一轮布局，也不会出现"先出现在下面、
   * 量完高度又跳到上面"的闪动。高度不固定的面板就报一个保守的上界。
   */
  estimateHeight?: () => number;
}

export interface AnchoredLayer<T extends HTMLElement> {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** 位置：为 `null` 表示还没量过（首次渲染的同一帧），此时先不渲染浮层 */
  anchor: LayerAnchor | null;
  triggerRef: RefObject<T | null>;
  layerRef: RefObject<HTMLDivElement | null>;
}

/**
 * 锚定浮层：把一个面板浮在触发元素旁边
 *
 * 【为什么必须 portal 出去】
 * 面板往往挂在有 `overflow: hidden` 的容器里（主区、覆盖层面板…），
 * `position: absolute` 的浮层一出边界就被**裁掉** —— 表现是"菜单没浮在上层、
 * 被挡住了"。所以在调用方 portal 到 `body`，这里只负责给出 fixed 坐标。
 *
 * 【这里统一了哪些事】
 *  1. 量触发元素的位置（左/右对齐、与它的间距）；
 *  2. 下方空间不足时**翻到上方**；
 *  3. 窗口 resize 与任意层级的滚动都重新量（capture 阶段监听：
 *     容器内部滚动不冒泡到 window，不这样听就会漏）；
 *  4. 点外面 / Esc 关闭（判断要**同时**覆盖触发元素与浮层本身 ——
 *     浮层已经 portal 出去了，不再是触发元素的后代）。
 *
 * `Dropdown` 与 `ContextMenu` 原先各写了一份同构的实现，
 * 改一处常常忘另一处 —— 所以抽到这里。
 */
export function useAnchoredLayer<T extends HTMLElement = HTMLDivElement>(
  { align = 'left', gap = 8, minWidth, estimateHeight }: AnchoredLayerOptions = {},
): AnchoredLayer<T> {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<LayerAnchor | null>(null);
  const triggerRef = useRef<T>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  /*
   * 估算函数放 ref：调用方通常写成内联箭头函数，每次渲染都是新引用，
   * 放进 `measure` 的依赖里会让它每帧都变 → 监听器反复拆装。
   */
  const estimateRef = useRef(estimateHeight);
  estimateRef.current = estimateHeight;

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;

    const box = el.getBoundingClientRect();
    const height = estimateRef.current?.() ?? 280;
    const spaceBelow = window.innerHeight - box.bottom;
    const flipUp = spaceBelow < height + gap && box.top > spaceBelow;

    setAnchor({
      ...(align === 'right'
        ? { right: Math.max(gap, window.innerWidth - box.right) }
        : { left: box.left, width: Math.max(box.width, minWidth ?? box.width) }),
      ...(flipUp ? { bottom: window.innerHeight - box.top + gap } : { top: box.bottom + gap }),
    });
  }, [align, gap, minWidth]);

  useEffect(() => {
    if (!open) return undefined;
    measure();

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || layerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  return { open, setOpen, anchor, triggerRef, layerRef };
}
