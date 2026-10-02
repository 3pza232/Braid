// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  /*
   * ── 下面几条都是"提示卡住不走"（用户实际遇到的两种）──
   *
   * 共同点：**`mouseleave` 没有机会发生**。所以只靠它收起是不够的，
   * 必须把"交互已经转移"的几种情形都覆盖到。
   */
  it('按下去立刻收起：点开的那个面板旁边不该再挂着一个浮层', () => {
    render(
      <Tooltip label="切换主题">
        <IconButton label="主题">×</IconButton>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '主题' });

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    // 真实场景：鼠标停在按钮上 → 点下去 → 按钮弹出一个菜单。
    // 这时指针还在按钮上，`mouseleave` 不会来。
    fireEvent.pointerDown(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('点开面板再关掉：**指针没动**时提示不该自己冒回来（用户报的就是这个）', () => {
    render(
      <Tooltip label="设置">
        <IconButton label="设置">×</IconButton>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '设置' });

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    // 点下去打开面板 → 立刻收起
    fireEvent.pointerDown(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    /*
     * 关掉面板。真实浏览器在这里会重做命中测试：遮挡物没了，指针底下又是那个按钮，
     * 于是**再派发一次 mouseenter** —— 而指针一格都没动。
     * 早先的实现在这一刻会把提示重新点亮，看起来就是"面板关掉了浮板还挂着"。
     */
    fireEvent.mouseOver(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    // 但也不是永久静音：指针真的动一下之后，悬停照常显示
    fireEvent.pointerMove(document.body);
    fireEvent.mouseOut(button);
    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('滚动就收起（提示按点击那一刻的坐标定位，不收起会与控件错位）', () => {
    render(<IconButton label="全局设置">×</IconButton>);
    fireEvent.mouseOver(screen.getByRole('button', { name: '全局设置' }));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.scroll(window);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('键盘触发的 click（detail=0）不会把提示静音', () => {
    render(<IconButton label="全局设置">×</IconButton>);
    const button = screen.getByRole('button', { name: '全局设置' });

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    /*
     * Enter/Space 触发的 click，其 `detail` 是 0（鼠标点击 ≥ 1）。
     * 若不分这一下，键盘用户点过一次之后就再也看不到任何提示了。
     */
    fireEvent.click(button, { detail: 0 });
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    fireEvent.mouseOut(button);
    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  /*
   * ── 用户报的那条：点开面板 → 关掉面板 → 浮板又出现（而指针并不在按钮上）──
   *
   * 完整因果链（每一环都在用例里）：
   *  1. 悬停按钮 → 浮板出现；
   *  2. 点开面板 → 浮板收起；
   *  3. **在面板里操作**（按 Tab、按 Esc —— 真实用户都会做）；
   *  4. 关闭面板 → `useModalFocus` 把焦点**还给当初打开它的那个按钮**；
   *  5. 那一次 focus 不是用户在指向它 → 不许点亮浮板。
   *
   * 第 3 步是早先版本翻车的地方：那时"按任意键"都会解除抑制，
   * 于是第 5 步畅通无阻。现在键盘路径的判据是"刚按过移动焦点的键"（Tab / 方向键），
   * Esc 更是反过来把这条路径也关掉。
   */
  it('点开面板→在里面按过键→关掉面板（焦点还给按钮）：不许点亮浮板', () => {
    render(
      <Tooltip label="设置">
        <IconButton label="设置">×</IconButton>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '设置' });

    fireEvent.mouseOver(button);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    // 点开面板：浮板立刻收起
    fireEvent.pointerDown(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    // 面板里按 Tab、再按 Esc（两种都试过）
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.keyDown(document, { key: 'Escape' });

    // 关掉面板 → 焦点还给按钮
    fireEvent.focus(button);

    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('另一种关法：面板里 Tab 过，再用鼠标点关闭 —— 同样不许点亮', () => {
    render(
      <Tooltip label="会话设置">
        <IconButton label="会话设置">×</IconButton>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '会话设置' });

    fireEvent.mouseOver(button);
    fireEvent.pointerDown(button);
    fireEvent.keyDown(document, { key: 'Tab' }); // 面板里 Tab 过（判定会被置上）

    /*
     * 用鼠标点面板的关闭按钮。**先 pointerdown 再 click** —— 真实鼠标点击就是这个顺序，
     * 而清掉键盘判据的正是 pointerdown 那一下（常驻监听，不依赖浮板是否显示）。
     */
    const close = document.createElement('button');
    document.body.append(close);
    fireEvent.pointerDown(close);
    fireEvent.click(close, { detail: 1 });
    close.remove();

    fireEvent.focus(button);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('键盘 Tab 到按钮上仍然显示提示（修 bug 不能把无障碍一起砍掉）', () => {
    render(<IconButton label="全局设置">×</IconButton>);
    const button = screen.getByRole('button', { name: '全局设置' });

    // 用户按 Tab 移动焦点，然后焦点落到按钮上 —— 这是"真的在指向它"
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focus(button);

    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('焦点移到别的控件上就收起', () => {
    render(
      <>
        <Tooltip label="会话设置">
          <IconButton label="设置">×</IconButton>
        </Tooltip>
        <button type="button">另一个按钮</button>
      </>,
    );
    fireEvent.mouseOver(screen.getByRole('button', { name: '设置' }));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.focusIn(screen.getByRole('button', { name: '另一个按钮' }));
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('切到后台（Alt+Tab）就收起，切回来不该还挂着', () => {
    render(<IconButton label="全局设置">×</IconButton>);
    fireEvent.mouseOver(screen.getByRole('button', { name: '全局设置' }));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.blur(window);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  it('触发元素被卸载后收起（元素消失时同样没有 mouseleave）', async () => {
    const { rerender } = render(
      <Tooltip label="删除此条">
        <IconButton label="删除">×</IconButton>
      </Tooltip>,
    );
    fireEvent.mouseOver(screen.getByRole('button', { name: '删除' }));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    /*
     * 行被过滤掉 / 面板被关闭：触发元素**直接不在文档里了**。
     * 元素的存亡没有事件可听，所以组件会在"有面板挂着"时每帧确认一次还能不能找到它。
     */
    rerender(
      <Tooltip label="删除此条">
        <span>已经换了一个元素</span>
      </Tooltip>,
    );

    await waitFor(() => expect(screen.queryAllByRole('tooltip')).toHaveLength(0));
  });
});
