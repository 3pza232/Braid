// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IconButton, Tooltip } from '@ui/primitives';

/**
 * 提示只有一处 —— 一个按钮只能有一个浮层
 *
 * 曾经的两种表现，说到底是同一个 bug：
 *  1. `IconButton` 自己写了原生 `title`，调用方又用 `<Tooltip>` 包一层 →
 *     鼠标一停**两个面板同时冒出来**，还是两套字（原生那个是按钮的 label，
 *     应用那个是外层给的说明）；
 *  2. 没被包住的那些按钮（收起侧栏、导出全部、会话设置…）**只有**那个慢半拍、
 *     不跟主题的原生浮层 —— 同一排按钮两种提示，看起来像没做完。
 *
 * 所以这里钉的是不变量：**按钮身上永远没有原生 `title`；悬停时最多一个 tooltip**。
 */
/** 造一个"假排版"：jsdom 没有布局，`getBoundingClientRect` 恒返回 0 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('按钮的提示只有一处', () => {
  afterEach(cleanup);

  it('裸 IconButton：自己用应用浮层，不写原生 title', () => {
    render(<IconButton label="收起侧栏">×</IconButton>);
    const button = screen.getByRole('button', { name: '收起侧栏' });

    expect(button.getAttribute('title')).toBeNull();

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('被 Tooltip 包住：不再叠第二层，且显示的是外层那句（信息量更大的那条）', () => {
    render(
      <Tooltip label="删除这条消息及其后续">
        <IconButton label="删除">×</IconButton>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '删除' });

    // 原生 title 不出现 —— 它就是"第二个浮动面板"的来源
    expect(button.getAttribute('title')).toBeNull();

    fireEvent.mouseOver(button);
    const tips = screen.getAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]?.textContent).toBe('删除这条消息及其后续');
  });

  it('面板贴着**子元素**走，而不是外层包裹（绝对定位的子元素曾让面板飘到屏幕另一头）', () => {
    const { container } = render(
      <Tooltip label="回到最上面">
        <button type="button" style={{ position: 'absolute' }}>
          ↑
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole('button');
    const wrapper = container.querySelector('span');

    /* 模拟消息区右下角那对按钮：外层包裹零尺寸停在左边，子元素在右下角 */
    if (wrapper) wrapper.getBoundingClientRect = () => rect(0, 0, 0, 0);
    button.getBoundingClientRect = () => rect(900, 700, 26, 26);

    fireEvent.mouseOver(button);

    // 水平居中于按钮（900 + 26/2）
    expect(screen.getByRole('tooltip').style.left).toBe('913px');
  });

  it('移开就收起（不留着一个浮层挂在屏幕上）', () => {
    render(<IconButton label="全局设置">×</IconButton>);
    const button = screen.getByRole('button', { name: '全局设置' });

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.mouseOut(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });
});
