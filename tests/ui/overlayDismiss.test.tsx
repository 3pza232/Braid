// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useOverlayDismiss } from '@ui/hooks/useOverlayDismiss';

/**
 * 点遮罩关闭的判定
 *
 * 用户报的：**在面板里按住不放、拖到面板外松手 → 面板被关掉**。
 *
 * 根因是 DOM 的一条规矩：`click` 会被派发到 mousedown 与 mouseup 的**共同祖先**上。
 * 在面板里按下、在遮罩上松手时，共同祖先恰好是遮罩 —— 于是"点遮罩关闭"被误触发。
 * 所以判据必须是"按下与松手都落在遮罩本身"，这个钩子把那两次都记下来。
 */
function Overlay({ onDismiss }: { onDismiss: () => void }) {
  const dismiss = useOverlayDismiss(onDismiss);
  return (
    <div data-testid="overlay" {...dismiss}>
      <div data-testid="panel">
        <button type="button">面板里的按钮</button>
      </div>
    </div>
  );
}

describe('点遮罩关闭', () => {
  afterEach(cleanup);

  it('按下与松手都在遮罩上 → 关闭', () => {
    const onDismiss = vi.fn();
    render(<Overlay onDismiss={onDismiss} />);
    const overlay = screen.getByTestId('overlay');

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay, { detail: 1 });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('在面板里按住、拖到遮罩上松手 → **不关闭**（用户报的那条）', () => {
    const onDismiss = vi.fn();
    render(<Overlay onDismiss={onDismiss} />);
    const overlay = screen.getByTestId('overlay');
    const panel = screen.getByTestId('panel');

    /*
     * 真实浏览器里这一次手势确实会发出一个 click，而它的目标是**共同祖先**（= 遮罩）——
     * 所以这里照样发一次 click：要验证的正是"判据不能只看 click"。
     */
    fireEvent.mouseDown(panel);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay, { detail: 1 });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('按下在遮罩、松手在面板里 → 也不关闭（松手的位置才算数）', () => {
    const onDismiss = vi.fn();
    render(<Overlay onDismiss={onDismiss} />);
    const overlay = screen.getByTestId('overlay');
    const panel = screen.getByTestId('panel');

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(panel);
    fireEvent.click(overlay, { detail: 1 });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('点面板里面的东西 → 不关闭（面板自己处理）', () => {
    const onDismiss = vi.fn();
    render(<Overlay onDismiss={onDismiss} />);
    const button = screen.getByRole('button', { name: '面板里的按钮' });

    fireEvent.mouseDown(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button, { detail: 1 });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
