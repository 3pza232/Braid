// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Notices } from '@ui/components/Notices';
import { useUiStore } from '@ui/stores/uiStore';

/**
 * 通知里的动作（目前只有"撤销"）
 *
 * 对"一击就覆盖用户手写内容"的操作（恢复默认设置、清空余额脚本、删除模型配置、
 * 把本会话覆盖全部恢复为继承），我们选了**通知 + 撤销**而不是确认框：
 * 正常操作一次点击就过，只有真做错了才需要那一下。
 *
 * 这套设计要成立，两件事必须对：动作真的被执行；执行完这条通知要收掉
 * （不然用户撤销了、提示还挂着，会以为没生效）。
 */
describe('通知的动作', () => {
  beforeEach(() => {
    useUiStore.setState({ notices: [] });
  });

  afterEach(cleanup);

  it('点"撤销"会执行动作，并把这条通知收掉', () => {
    const run = vi.fn();
    useUiStore.getState().pushNotice({
      tone: 'alert',
      message: '已恢复默认设置',
      action: { label: '撤销', run },
    });

    render(<Notices />);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notices).toHaveLength(0);
  });

  it('没有动作的通知不渲染这个按钮（别给一个点了没用的入口）', () => {
    useUiStore.getState().pushNotice({ tone: 'error', message: '导入失败：文件损坏' });

    render(<Notices />);

    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.getByText('导入失败：文件损坏')).toBeTruthy();
  });
});
