import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTINUATION_PROMPT,
  DEFAULT_WRITING_MODES,
  WRITING_MODES,
  charsPerRoundOf,
  estimatedRounds,
  softMaxOf,
  type WritingModePreset,
} from '@domain/value-objects/writingMode';

const preset = (overrides: Partial<WritingModePreset> = {}): WritingModePreset => ({
  mode: 'short',
  label: '短',
  enabled: true,
  minOutputChars: 4000,
  softMaxRatio: 1.3,
  continuation: 'auto',
  stallLimit: 2,
  ...overrides,
});

describe('softMaxOf', () => {
  it('软上限 = 下限 × 系数', () => {
    expect(softMaxOf(preset({ minOutputChars: 4000, softMaxRatio: 1.3 }))).toBe(5200);
    expect(softMaxOf(preset({ minOutputChars: 100_000, softMaxRatio: 1.3 }))).toBe(130_000);
  });

  it('取整到整数：界面显示的是"约 13 万字"，不该出现小数', () => {
    expect(softMaxOf(preset({ minOutputChars: 3333, softMaxRatio: 1.15 }))).toBe(3833);
  });
});

describe('estimatedRounds（"约需 20 轮"这种提示的来源）', () => {
  const TOKENS_8K = 8192;

  it('续写关闭时只有 1 轮 —— 别让用户以为关掉后还会自动连写', () => {
    expect(estimatedRounds(preset({ continuation: 'off', minOutputChars: 100_000 }), TOKENS_8K)).toBe(1);
  });

  it('按每轮实际能产出的字数换算并向上取整', () => {
    // 8192 token ÷ 0.7 ≈ 11,703 汉字/轮（汉字系数见 usage.ts 里那张实测表）
    expect(estimatedRounds(preset({ minOutputChars: 20_000 }), TOKENS_8K)).toBe(2); // ceil(1.71)
    expect(estimatedRounds(preset({ minOutputChars: 96_000 }), TOKENS_8K)).toBe(9); // ceil(8.20)
  });

  it('下限极小也至少报 1 轮（0 轮没有意义）', () => {
    expect(estimatedRounds(preset({ minOutputChars: 0 }), TOKENS_8K)).toBe(1);
    expect(estimatedRounds(preset({ minOutputChars: 10 }), TOKENS_8K)).toBe(1);
  });

  /*
   * 「每轮能写多少」**从生效的单轮输出上限换算**，不写死一个数。
   *
   * 这一条是回归：早先默认写死"每轮 4,800 字"（那是 maxTokens = 8192 的换算结果）。
   * 上限放开到 100 万 token 之后，用户填 384,000 时会被说成"约需 80 轮" ——
   * 而这个数字是他判断"要花多久、多少钱"的依据。
   */
  it('按传入的单轮输出上限换算：上限越大，需要的轮数越少', () => {
    expect(charsPerRoundOf(TOKENS_8K)).toBe(11_703); // 8192 ÷ 0.7

    const target = preset({ minOutputChars: 10_000 });
    expect(estimatedRounds(target, TOKENS_8K)).toBe(1); // 一轮就能写过 1 万字
    expect(estimatedRounds(target, 384_000)).toBe(1);
  });
});

describe('内置档位预设', () => {
  it('短 / 中 / 长三个档位齐全且顺序固定', () => {
    expect(WRITING_MODES).toEqual(['short', 'medium', 'long']);
    expect(Object.keys(DEFAULT_WRITING_MODES)).toEqual(['short', 'medium', 'long']);
  });

  it.each(WRITING_MODES)('%s 的软上限严格大于下限（否则会在达标前停下）', (mode) => {
    const target = DEFAULT_WRITING_MODES[mode];
    expect(softMaxOf(target)).toBeGreaterThan(target.minOutputChars);
  });

  it.each(WRITING_MODES)('%s 的下限是正数，且防重复阈值合理', (mode) => {
    const target = DEFAULT_WRITING_MODES[mode];
    expect(target.minOutputChars).toBeGreaterThan(0);
    // stallLimit 为 0 会让"鬼打墙"保护立即触发，等于关掉了续写
    expect(target.stallLimit).toBeGreaterThan(0);
    // 「每轮最多写多少」不在这里：那是全局共享的 sampling.maxTokens（设置 → 上下文）
  });

  it('三个档位的下限递增（短 < 中 < 长）', () => {
    expect(DEFAULT_WRITING_MODES.short.minOutputChars).toBeLessThan(
      DEFAULT_WRITING_MODES.medium.minOutputChars,
    );
    expect(DEFAULT_WRITING_MODES.medium.minOutputChars).toBeLessThan(
      DEFAULT_WRITING_MODES.long.minOutputChars,
    );
  });

  it('"短"档默认不自动续写 —— 短内容本来就该一次写完', () => {
    expect(DEFAULT_WRITING_MODES.short.continuation).toBe('off');
  });

  it('中 / 长默认自动续写', () => {
    expect(DEFAULT_WRITING_MODES.medium.continuation).toBe('auto');
    expect(DEFAULT_WRITING_MODES.long.continuation).toBe('auto');
  });

  it('每个档位的 mode 字段与它在表里的键一致（错位会让 UI 高亮错档位）', () => {
    for (const mode of WRITING_MODES) {
      expect(DEFAULT_WRITING_MODES[mode].mode).toBe(mode);
    }
  });
});

describe('DEFAULT_CONTINUATION_PROMPT', () => {
  /*
   * 【这一版是用户换的：从"硬约束"改成"说明来意"】
   *
   * 上一版是四条硬约束（不要重复 / 不要元话语 / 保持人称时态密度 / 不要强行收尾）。
   * 实际上手写长文时发现模型开始**用提要式写法跳过内容**（一行一章往前推）——
   * "不要重复"与"不要跳跃"被一起执行了。所以现在只说明这条指令的来意，
   * 把创作空间还给模型。
   *
   * 因此下面钉的是这段文案的**意图**，而不是具体句子。如果哪天又出现大段重复，
   * 正确的修法是改这段文案（见 `value-objects/writingMode.ts` 里的注释），
   * 改完这里也要跟着改 —— 这种"故意写死"的断言就是为了让改动留下痕迹。
   */
  it('说明来源：这是工具为了凑够单次输出量补的，不是用户在催更', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('工具');
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('足够多内容量');
  });

  it('明确请它别被这段指令影响创作（否则会被当成新的写作要求）', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('无需在意');
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('别被这段指令影响');
  });

  it('不再带硬约束 —— 那一版会让模型为"避免重复"而跳过内容（用户实测）', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).not.toContain('不要重复');
    expect(DEFAULT_CONTINUATION_PROMPT).not.toContain('元话语');
  });

  it('是多行文本，不是被压成一行', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('\n');
  });
});
