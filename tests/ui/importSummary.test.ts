// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { stashImportSummary, takeImportSummary } from '@ui/utils/importSummary';

/**
 * 导入汇总的跨重载交接
 *
 * 备份导入后界面会整页重载，而"导入了多少、跳过了多少、丢了什么"这些话
 * 只在那一刻有用 —— 早先它被重载立刻冲掉，用户永远看不到。
 * 这里钉住两条：能带过重载；**只能显示一次**（否则每次打开应用都冒出来）。
 */
afterEach(() => {
  window.sessionStorage.clear();
});

describe('导入汇总的交接', () => {
  it('存下之后能取到（这就是"带过重载"）', () => {
    stashImportSummary('已导入 3 个会话、12 条消息。');

    expect(takeImportSummary()).toBe('已导入 3 个会话、12 条消息。');
  });

  it('取一次就没了 —— 不该每次打开应用都再冒出来', () => {
    stashImportSummary('已导入 1 个会话。');

    expect(takeImportSummary()).not.toBeNull();
    expect(takeImportSummary()).toBeNull();
  });

  it('没存过就是 null（启动时不该凭空弹一条通知）', () => {
    expect(takeImportSummary()).toBeNull();
  });
});
