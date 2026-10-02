// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDragReorder } from '@ui/hooks/useDragReorder';

/**
 * 拖动排序的**事件接线**
 *
 * 算法本身在 `dragReorder.test.ts` 里单独测过了；这里测的是另一半：
 * 拖拽事件有没有正确地接到"提交新顺序"上 ——
 * 例如忘了 `preventDefault`（drop 根本不触发）、把整个列表都提交了、
 * 或者键盘路径没接。属于"能跑起来但按了没反应"那一类问题。
 *
 * 【两次接线：手柄 + 列表容器】
 * `handleProps` 挂在手柄上（拖动起点），`listProps` 挂在**列表容器**上（投放判定）。
 * 早先判定在手柄上，于是"在最后一行下方松手"这一下没有任何目标、被整个忽略 ——
 * 那正是用户最习惯的动作，所以这里专门钉一条用例。
 *
 * 行上写 `data-drag-id`（用**字面量**写，故意不引常量：调用方也是手写的，
 * 常量改了这里就该红 —— 它守的是"三处调用方都写对了"这个约定）。
 */

/** 给一行摆一份"假排版"：jsdom 没有排版，`getBoundingClientRect` 恒返回 0 */
function stubRowRect(element: HTMLElement, top: number, height = 18): void {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** 每行 18px、间隔 2px —— 于是第 i 行占 `[i*20, i*20+18]` */
function layoutList(ids: readonly string[]): void {
  ids.forEach((id, index) => stubRowRect(screen.getByTestId(`row-${id}`), index * 20));
}

/**
 * 在 `y` 处投放
 *
 * 必须自己造 `MouseEvent`，不能用 `fireEvent.drop(element, { clientY })`：
 * jsdom 没实现 `DragEvent`，testing-library 会退回 `Event`，而 `Event` 的构造函数
 * **不认 `clientY`** —— 事件上根本没有这个属性，判定读到 `undefined`，
 * 落点永远算不出来。症状是"用例以'拖了没反应'的形式失败"，看起来像功能坏了，
 * 其实是夹具不到位。真浏览器里拖拽事件是真的 `DragEvent`，不存在这个问题。
 */
function dropAt(element: HTMLElement, y: number, type: 'drop' | 'dragover' = 'drop'): void {
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y }));
}

function Harness({ ids, onReorder }: { ids: string[]; onReorder: (next: string[]) => void }) {
  const drag = useDragReorder(ids, onReorder);

  return (
    <ul data-testid="list" {...drag.listProps}>
      {ids.map((id) => (
        <li key={id} data-testid={`row-${id}`} data-drag-id={id} data-over={drag.overId === id}>
          <span
            data-testid={`grip-${id}`}
            {...drag.handleProps(id, `拖动 ${id}`)}
            aria-label={`拖动 ${id}`}
          >
            ≡
          </span>
          {id}
        </li>
      ))}
    </ul>
  );
}

describe('useDragReorder 的事件接线', () => {
  afterEach(cleanup);

  it('从 a 拖到 c 所在的位置：提交的顺序是 a 占用 c 的位置', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b', 'c', 'd']} onReorder={onReorder} />);
    layoutList(['a', 'b', 'c', 'd']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    // 44 落在第三行（40-58）里
    dropAt(screen.getByTestId('list'), 44, 'dragover');
    dropAt(screen.getByTestId('list'), 44);

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a', 'd']);
  });

  it('拖到**最后一行下方的空白**再松手：落到最后（早先这一下会被整个忽略）', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b', 'c', 'd']} onReorder={onReorder} />);
    layoutList(['a', 'b', 'c', 'd']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    // 远在最后一行（60-78）下方：列表底部的空白区
    dropAt(screen.getByTestId('list'), 400, 'dragover');
    dropAt(screen.getByTestId('list'), 400);

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'd', 'a']);
  });

  it('拖到第一行上方：落到最前', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b', 'c']} onReorder={onReorder} />);
    layoutList(['a', 'b', 'c']);

    fireEvent.dragStart(screen.getByTestId('grip-c'));
    dropAt(screen.getByTestId('list'), -20);

    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('拖到自己身上：不提交（省掉一次无意义的落库）', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b']} onReorder={onReorder} />);
    layoutList(['a', 'b']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    dropAt(screen.getByTestId('list'), 5);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('拖到别的行上时高亮目标行（data-over）', () => {
    render(<Harness ids={['a', 'b']} onReorder={() => undefined} />);
    layoutList(['a', 'b']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    dropAt(screen.getByTestId('list'), 25, 'dragover');

    expect(screen.getByTestId('row-b').getAttribute('data-over')).toBe('true');
  });

  it('悬停在列表底部空白时，高亮**最后一行**（松手前就能看出会放到最下面）', () => {
    render(<Harness ids={['a', 'b']} onReorder={() => undefined} />);
    layoutList(['a', 'b']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    dropAt(screen.getByTestId('list'), 300, 'dragover');

    expect(screen.getByTestId('row-b').getAttribute('data-over')).toBe('true');
  });

  it('键盘：Alt + ↓ 往后挪一位（拖拽对只用键盘的人不可用）', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b', 'c']} onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByTestId('grip-a'), { key: 'ArrowDown', altKey: true });

    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('键盘：不带 Alt 的上下键不抢列表自己的行为', () => {
    const onReorder = vi.fn();
    render(<Harness ids={['a', 'b']} onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByTestId('grip-b'), { key: 'ArrowUp' });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('drop 之后清掉拖动状态（否则插入线会一直留着）', () => {
    render(<Harness ids={['a', 'b']} onReorder={() => undefined} />);
    layoutList(['a', 'b']);

    fireEvent.dragStart(screen.getByTestId('grip-a'));
    dropAt(screen.getByTestId('list'), 25, 'dragover');
    dropAt(screen.getByTestId('list'), 25);

    expect(screen.getByTestId('row-b').getAttribute('data-over')).toBe('false');
  });
});
