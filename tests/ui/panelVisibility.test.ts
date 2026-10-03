import { describe, expect, it } from 'vitest';
import { autoPanelOpen } from '@ui/utils/panelVisibility';

/**
 * 过程面板的自动展开规则
 *
 * 这套规则被改坏过两次，两次的根因是同一个：判据问的是"**有没有东西在跑**"，
 * 而不是"**现在处于哪个阶段**"。用例把三条规则逐条钉住，改错时能直接看出是哪一条。
 */
describe('autoPanelOpen', () => {
  const base = { reasoningAlwaysOpen: false, toolsAlwaysOpen: false, follow: true };

  it('思考阶段：只展开思考框', () => {
    expect(autoPanelOpen({ ...base, phase: 'reasoning' })).toEqual({ reasoning: true, tools: false });
  });

  it('工具阶段：只展开工具框（这里不问"工具是否还在跑"）', () => {
    /*
     * 工具跑完、模型还没开口的那一段**仍算工具阶段**（阶段由服务端在工具开始执行时置上，
     * 一直保持到正文或思考出现）。否则写一个文件只要几十毫秒，那个框会一闪而过。
     */
    expect(autoPanelOpen({ ...base, phase: 'tool' })).toEqual({ reasoning: false, tools: true });
  });

  it('正文阶段：两个都折叠 —— 把版面让给正文', () => {
    expect(autoPanelOpen({ ...base, phase: 'text' })).toEqual({ reasoning: false, tools: false });
  });

  it('没有在生成：两个都折叠（历史消息保持默认收起）', () => {
    expect(autoPanelOpen({ ...base, phase: null })).toEqual({ reasoning: false, tools: false });
  });

  it('总开关关掉：任何阶段都不自动展开，只由用户手动开合', () => {
    for (const phase of ['reasoning', 'tool', 'text', null] as const) {
      expect(autoPanelOpen({ ...base, follow: false, phase })).toEqual({
        reasoning: false,
        tools: false,
      });
    }
  });

  it('「思考过程默认展开」与阶段无关，且不会顺手把工具框也带开', () => {
    expect(autoPanelOpen({ ...base, reasoningAlwaysOpen: true, phase: 'text' }).reasoning).toBe(true);
    expect(autoPanelOpen({ ...base, reasoningAlwaysOpen: true, phase: null }).reasoning).toBe(true);
    expect(autoPanelOpen({ ...base, reasoningAlwaysOpen: true, phase: 'text' }).tools).toBe(false);
  });

  it('「工具使用过程默认展开」与它对称：常展开、也不带开思考框', () => {
    expect(autoPanelOpen({ ...base, toolsAlwaysOpen: true, phase: 'text' }).tools).toBe(true);
    // 收工之后（阶段为 null）依然展开 —— 这正是"常展开"与"跟随阶段"的区别
    expect(autoPanelOpen({ ...base, toolsAlwaysOpen: true, phase: null }).tools).toBe(true);
    expect(autoPanelOpen({ ...base, toolsAlwaysOpen: true, phase: 'text' }).reasoning).toBe(false);
  });

  it('续写的第二轮：又是工具阶段时会重新展开（不是"整条只展开一次"）', () => {
    const round1 = autoPanelOpen({ ...base, phase: 'text' });
    const round2 = autoPanelOpen({ ...base, phase: 'tool' });
    expect([round1.tools, round2.tools]).toEqual([false, true]);
  });
});
