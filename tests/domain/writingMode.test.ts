import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTINUATION_PROMPT,
  DEFAULT_WRITING_MODES,
  WRITING_MODES,
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
  maxTokensPerRequest: 8192,
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
  it('续写关闭时只有 1 轮 —— 别让用户以为关掉后还会自动连写', () => {
    expect(estimatedRounds(preset({ continuation: 'off', minOutputChars: 100_000 }))).toBe(1);
  });

  it('按每轮实际能产出的字数换算并向上取整', () => {
    expect(estimatedRounds(preset({ minOutputChars: 20_000 }), 4800)).toBe(5); // ceil(4.17)
    expect(estimatedRounds(preset({ minOutputChars: 96_000 }), 4800)).toBe(20);
  });

  it('下限极小也至少报 1 轮（0 轮没有意义）', () => {
    expect(estimatedRounds(preset({ minOutputChars: 0 }), 4800)).toBe(1);
    expect(estimatedRounds(preset({ minOutputChars: 10 }), 4800)).toBe(1);
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
    expect(target.maxTokensPerRequest).toBeGreaterThan(0);
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
   * 续写提示词是"防重复"的主力（见 value-objects/writingMode.ts 的说明）：
   * 它必须明确禁止复述前文，否则多轮续写会出现大段重复。
   * 这类文案很容易在改写时被稀释掉，所以把关键约束钉在这里。
   */
  it('明确要求不复述前文', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('不要重复');
  });

  it('明确说明"被截断不等于写完"，否则模型会自己收尾', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('截断');
  });

  it('要求从断点无缝衔接', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('无缝衔接');
  });

  it('是多行文本，不是被压成一行', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toContain('\n');
  });
});
