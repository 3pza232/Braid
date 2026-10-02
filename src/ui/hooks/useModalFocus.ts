import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** 面板内可聚焦的元素（与浏览器默认的 Tab 序列基本一致） */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalFocus<T extends HTMLElement = HTMLDivElement> {
  /** 挂到面板的根元素上 */
  ref: RefObject<T | null>;
  /** 挂到面板的根元素上（处理 Tab 循环） */
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * 模态面板的焦点管理
 *
 * 【为什么必须有它】
 * 三个覆盖层面板都写着 `aria-modal="true"`，但在此之前**没有任何焦点处理**：
 * 打开后焦点还留在背后的按钮上，Tab 能一路跑到面板外面去。对键盘用户来说
 * 这个"模态"是假的；而读屏软件会按 `aria-modal` 的承诺去隐藏背景内容，
 * 于是焦点落在一片"读屏看不见"的地方 —— 比没有 aria-modal 更糟。
 *
 * 做三件事，正好对应上面三个问题：
 *  1. 打开时把焦点移进面板（面板自身或第一个可聚焦元素）；
 *  2. `Tab` / `Shift+Tab` 在面板内循环（焦点陷阱）；
 *  3. 关闭时把焦点**还给打开它的那个元素**（否则用户会掉到页面开头，
 *     对"我在列表第 20 条点开的设置"这种场景尤其难受）。
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(): ModalFocus<T> {
  const ref = useRef<T>(null);
  /** 打开面板之前的焦点位置，关闭时归还 */
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return undefined;

    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement ? active : null;

    /*
     * 优先聚焦第一个可聚焦元素，而不是面板本身：用户按 Tab 的期待是
     * "从这里开始往下走"。面板本身留作兜底（它带 tabIndex={-1}，可程序聚焦不可 Tab 到）。
     */
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();

    return () => {
      // 归还焦点前确认它还挂在文档上（可能已经被卸载了）
      const target = returnTo.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const panel = ref.current;
    if (!panel) return;

    /*
     * 刻意**不做可见性过滤**
     *
     * 常见写法是用 `offsetParent !== null` 或 `checkVisibility()` 滤掉隐藏元素，
     * 但两者都依赖布局：jsdom 里 `offsetParent` 恒为 `null`、`checkVisibility()`
     * 也没有真实排版可依据 —— 而"Tab 会不会跑出面板"正是能在 jsdom 里验证的行为，
     * 不能因为一个过滤条件把测试逼成摆设。
     *
     * 不过滤是安全的：`display:none` 的元素 `focus()` 会静默失败，焦点仍留在原处，
     * 最坏情况只是那一次 Tab 没有折返（而选择器已经把 disabled 与 tabindex=-1 排除了）。
     */
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;

    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const current = document.activeElement;

    /*
     * 只在**边界**上接管：从最后一个往后、或从第一个往前，才把它折回另一端。
     * 中间的自由 Tab 不动 —— 完全接管会让浏览器的默认行为（含 :focus-visible 的
     * 判定与读屏的播报）失效。
     */
    if (!event.shiftKey && (current === last || !panel.contains(current))) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && (current === first || !panel.contains(current))) {
      event.preventDefault();
      last.focus();
    }
  }, []);

  return { ref, onKeyDown };
}
