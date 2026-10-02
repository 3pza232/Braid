import { useId } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredLayer } from '@ui/hooks/useAnchoredLayer';
import styles from './Dropdown.module.css';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 下拉选择
 *
 * 【为什么不用原生 `<select>`】
 *  1. **展开方向不可控**：原生弹层由操作系统绘制，在窗口底部时经常被截断；
 *  2. **样式不可控**：字体、圆角、悬停态都无法跟随主题令牌，在一排按钮里显得格格不入。
 *
 * 【这个实现的三个要点】
 *  - 用 portal 渲染到 body：面板里有 `overflow: hidden`，不脱出去会被裁掉；
 *  - **空间不足时向上翻转**（与 Tooltip 同一套思路）：下方放不下就显示在触发区上方；
 *  - 关闭靠 document 级 mousedown + Escape，并且在 resize/scroll 时重新量位置，
 *    否则面板滚动后弹层会停在原地。
 */
export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  width,
  placeholder = '请选择',
}: {
  options: Array<DropdownOption<T>>;
  value: T;
  onChange: (value: T) => void;
  width?: number;
  placeholder?: string;
}) {
  /*
   * 定位与关闭逻辑与 `ContextMenu` 完全同构（portal + fixed + 量触发元素 +
   * 空间不足翻转 + 点外面/Esc 关闭 + resize/滚动重算），统一在 `useAnchoredLayer`。
   * 原先两边各写一份，改一处常常忘另一处。
   */
  const {
    open,
    setOpen,
    anchor,
    triggerRef,
    layerRef: menuRef,
  } = useAnchoredLayer<HTMLButtonElement>({
    gap: 4,
    minWidth: 160,
    // 菜单高度按条数估：下方放不下就翻到上面去
    estimateHeight: () => Math.min(280, options.length * 30 + 12) + 12,
  });

  const current = options.find((option) => option.value === value);

  /*
   * 无障碍：把"当前选中的是哪一项"告诉读屏软件
   *
   * 焦点始终在触发按钮上（这是这个组件的交互模型：方向键**直接改选中项**），
   * 所以按 ARIA 的 listbox 模式，要用 `aria-activedescendant` 指向被激活的选项，
   * 而不是把焦点搬进列表 —— 那样会顺带改掉方向键的既有行为。
   */
  const listId = useId();
  const optionId = (optionValue: string) => `${listId}-opt-${optionValue}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        style={width !== undefined ? { width } : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(value) : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          // 键盘也能用：上下键直接切换选中项，Enter/Space 开合
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            const index = options.findIndex((option) => option.value === value);
            const next =
              event.key === 'ArrowDown'
                ? Math.min(options.length - 1, index + 1)
                : Math.max(0, index - 1);
            const target = options[next];
            if (target) onChange(target.value);
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((previous) => !previous);
          }
        }}
      >
        <span className={styles.label}>{current?.label ?? placeholder}</span>
        <svg
          className={styles.chevron}
          data-open={open}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.menu}
              id={listId}
              role="listbox"
              style={{ left: anchor.left, width: anchor.width, top: anchor.top, bottom: anchor.bottom }}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  id={optionId(option.value)}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={styles.item}
                  data-active={option.value === value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
