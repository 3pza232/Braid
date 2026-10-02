// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BraidProvider } from '@ui/BraidProvider';
import { SettingsPanel } from '@ui/panels/SettingsPanel';
import { createFakeContainer, installBrowserStubs } from '../helpers/fakeContainer';

/**
 * 设置面板的**冒烟测试**
 *
 * 【为什么先写它再拆文件】
 * 这个面板要拆成多个子组件，拆的过程里最容易出的错不是逻辑错，而是
 * "漏搬了一个 props / 少 import 了一个东西 / 某个分区引用了外面才有的变量" ——
 * 这类错误类型检查抓不全（props 可选、`any` 兜底），而**每个分区都渲染一遍**
 * 是最直接的防线：12 个分区，每个都渲染一次，谁坏了立刻现形。
 *
 * 额外盯住 `console.error`：React 对"未知 DOM 属性""嵌套非法"这类问题只打印警告，
 * 不会让渲染失败 —— 拆完界面看着正常、控制台全是红字，那种情况必须当失败。
 */
describe('SettingsPanel 冒烟测试', () => {
  beforeEach(() => {
    installBrowserStubs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mount = () =>
    render(
      <BraidProvider container={createFakeContainer()}>
        <SettingsPanel />
      </BraidProvider>,
    );

  it('面板以 dialog 形式渲染，导航列出全部分区', () => {
    mount();

    const dialog = screen.getByRole('dialog', { name: '设置' });
    const nav = within(dialog).getByRole('navigation', { name: '设置分类' });

    expect(within(nav).getAllByRole('button').length).toBeGreaterThanOrEqual(10);
  });

  it('每个分区都能渲染出内容，且不产生 React 报错', () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    mount();

    const dialog = screen.getByRole('dialog', { name: '设置' });
    const nav = within(dialog).getByRole('navigation', { name: '设置分类' });
    const items = within(nav).getAllByRole('button');

    for (const item of items) {
      fireEvent.click(item);
      // 点完必须切到该分区并渲染出东西 —— 空白页说明这个分区分支坏了
      const label = item.textContent ?? '';
      expect(dialog.textContent).toContain(label);
    }

    expect(errors.map((args) => String(args[0]))).toEqual([]);
  });
});
