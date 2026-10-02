import type { HTMLAttributes, ReactNode } from 'react';
import { IconGrip } from '@ui/components/Icons';
import styles from './DragHandle.module.css';

export interface DragHandleProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * 落位方式
   *
   * - `inline`：作为行内的 flex 兄弟（消息信息栏 —— 行本身就是一行"标签 + 开关"）；
   * - `gutter`：**绝对落在行的左内边距里**（三个列表）—— 这样手柄不占行的宽度，
   *   行盒子（含悬停底色）与上方的搜索框同宽。早先手柄是 flex 兄弟，
   *   于是每一行都比搜索框窄/歪出去一截。
   */
  placement?: 'inline' | 'gutter';
  /** 默认画三横线图标；需要别的形状时传 children */
  children?: ReactNode;
}

/**
 * 拖动手柄
 *
 * 【为什么要抽成一个组件】
 * 同一件事（"按住这里可以调整顺序"）原先在四个地方各写了一套，
 * 样式与显隐规则还各不相同，同一操作看起来像两件事。
 * 现在四处共用这一个：视觉一致，行为（悬停/聚焦/拖动/键盘）也一致。
 *
 * 【为什么由它自己画图标】
 * 手柄的样子是**这个组件的事**，调用方只需要说"这里可以拖"。
 * 需要换形状时传 `children` 即可，不必改四个调用点。
 *
 * 它是**功能性**元素而非装饰：调用方会给它 `role="button"`、`tabIndex`
 * 与键盘处理（见 `useDragReorder`），所以焦点环是必须的。
 */
export function DragHandle({ placement = 'inline', className, children, ...rest }: DragHandleProps) {
  const classes = [styles.handle, placement === 'gutter' ? styles.gutter : styles.inline, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} data-drag-handle={placement} {...rest}>
      {children ?? <IconGrip size={14} />}
    </span>
  );
}
