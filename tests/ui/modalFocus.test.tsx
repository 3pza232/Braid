// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useModalFocus } from '@ui/hooks/useModalFocus';

// jsdom 的 DOM 在用例之间不会自动清空：不清就会让 getByTestId 命中多个元素
afterEach(cleanup);

/**
 * 模态面板的焦点管理
 *
 * 这些是**行为**而不是布局：焦点在哪、Tab 会不会跑出去、关掉之后焦点回不回到
 * 原来的地方 —— jsdom 完全能验（因此这类用例值得写；几何相关的才测不了）。
 *
 * 为什么值得测：之前三个面板都写着 `aria-modal="true"` 却没有任何焦点处理，
 * 键盘用户按 Tab 会直接跑到面板背后去。这种问题在鼠标下完全看不出来。
 */

function Panel({ onClose }: { onClose?: () => void }) {
  const focus = useModalFocus<HTMLDivElement>();

  return (
    <div ref={focus.ref} tabIndex={-1} onKeyDown={focus.onKeyDown} data-testid="panel">
      <button type="button" data-testid="first">
        第一个
      </button>
      <button type="button" data-testid="last">
        最后一个
      </button>
      {onClose ? (
        <button type="button" data-testid="close" onClick={onClose}>
          关闭
        </button>
      ) : null}
    </div>
  );
}

/** 用一个开关模拟"打开面板 / 关闭面板"，并保留打开它的那个按钮 */
function Host() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        打开设置
      </button>
      {open ? <Panel onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

describe('模态面板的焦点管理', () => {
  it('打开时焦点进入面板（而不是留在背后的按钮上）', () => {
    const { getByTestId } = render(<Host />);

    act(() => {
      getByTestId('opener').focus();
      fireEvent.click(getByTestId('opener'));
    });

    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Tab 到最后一个之后回到第一个（焦点陷阱）', () => {
    const { getByTestId } = render(<Host />);
    act(() => {
      fireEvent.click(getByTestId('opener'));
    });

    // close 是最后一个可聚焦元素
    act(() => {
      getByTestId('close').focus();
    });
    fireEvent.keyDown(getByTestId('panel'), { key: 'Tab' });

    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Shift+Tab 在第一个上时折回最后一个', () => {
    const { getByTestId } = render(<Host />);
    act(() => {
      fireEvent.click(getByTestId('opener'));
    });

    act(() => {
      getByTestId('first').focus();
    });
    fireEvent.keyDown(getByTestId('panel'), { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(getByTestId('close'));
  });

  it('中间位置不接管：浏览器默认的 Tab 顺序不被破坏', () => {
    const { getByTestId } = render(<Host />);
    act(() => {
      fireEvent.click(getByTestId('opener'));
    });

    act(() => {
      getByTestId('first').focus();
    });
    const event = fireEvent.keyDown(getByTestId('panel'), { key: 'Tab' });

    // 未被 preventDefault：说明我们没有把中间的 Tab 也抢过来
    expect(event).toBe(true);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('关闭时把焦点还给打开它的元素', () => {
    const { getByTestId } = render(<Host />);
    act(() => {
      getByTestId('opener').focus();
      fireEvent.click(getByTestId('opener'));
    });
    expect(document.activeElement).toBe(getByTestId('first'));

    /*
     * 点"关闭"会让宿主把面板卸载 —— hook 的清理函数负责把焦点还回去。
     * 这里不需要额外 cleanup：卸载本身就发生在这次点击里。
     */
    act(() => {
      fireEvent.click(getByTestId('close'));
    });

    expect(document.activeElement).toBe(getByTestId('opener'));
  });
});
