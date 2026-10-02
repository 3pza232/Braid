import { describe, expect, it } from 'vitest';
import { clampNumber } from '@ui/primitives/Controls';

/**
 * 数字输入的钳制
 *
 * 这不是"界面小事"：清空输入框时 `Number('') === 0`，早先会把
 * 「上下文长度」「单次最大输出」「保留最近原文」这类**有下限**的设置写成 0，
 * 之后上下文预算与请求参数就按 0 去算。所以规则本身要有用例钉住。
 */
describe('clampNumber', () => {
  it('低于下限抬到下限（清空输入框那种情况就落到这里）', () => {
    expect(clampNumber(0, 4096)).toBe(4096);
    expect(clampNumber(-5, 1)).toBe(1);
  });

  it('高于上限压到上限', () => {
    expect(clampNumber(999_999, 256, 32_768)).toBe(32_768);
  });

  it('范围内原样返回（不打乱用户输入）', () => {
    expect(clampNumber(8192, 4096, 32_768)).toBe(8192);
  });

  it('没给边界就不动（有些字段本来就没有上下限）', () => {
    expect(clampNumber(123)).toBe(123);
    expect(clampNumber(-3)).toBe(-3);
  });

  it('只给一个边界时只管那一边', () => {
    expect(clampNumber(10, 100)).toBe(100);
    expect(clampNumber(10, undefined, 4)).toBe(4);
  });
});
