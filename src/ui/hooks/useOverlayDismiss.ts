import { useRef, type MouseEvent, type MouseEventHandler } from 'react';

export interface OverlayDismiss {
  onMouseDown: MouseEventHandler<HTMLElement>;
  onMouseUp: MouseEventHandler<HTMLElement>;
  onClick: MouseEventHandler<HTMLElement>;
}

/**
 * 「点遮罩关闭」的判定
 *
 * 【为什么不能只写 `onClick={close}`】
 * `click` 事件会被派发到 **mousedown 与 mouseup 的共同祖先**上。于是
 * "在面板里按住、拖出去松手"这种手势，click 的目标变成了遮罩 → 面板被关掉
 *（用户实际报的就是这个：按住不放、移到面板外松手，面板关了）。
 * 那不是"点遮罩"，只是拖出来松手 —— 用户根本没打算关它。
 *
 * 所以要求**按下与松手都落在遮罩本身**上：两次都判一次 `target === currentTarget`，
 * 中间任何一次落在面板里就作废。面板里不再需要 `stopPropagation`（那是另一回事：
 * 它只能挡住"从面板内部发起"的 click，挡不住拖出去的那一次）。
 *
 * 抽成钩子是因为三个覆盖层面板（设置 / 会话设置 / 角色预设）都要这一条规则 ——
 * 复制三份的话，将来只改一处就会变成"有的面板能拖，有的不能"。
 */
export function useOverlayDismiss(onDismiss: () => void): OverlayDismiss {
  /** 按下时是否在遮罩本身（松手时再确认一次） */
  const onOverlay = useRef(false);

  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      onOverlay.current = event.target === event.currentTarget;
    },
    onMouseUp: (event: MouseEvent<HTMLElement>) => {
      onOverlay.current = onOverlay.current && event.target === event.currentTarget;
    },
    onClick: () => {
      if (onOverlay.current) onDismiss();
    },
  };
}
