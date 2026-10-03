import { describe, expect, it } from 'vitest';
import {
  addUsage,
  cacheHitRate,
  cacheStatsOf,
  commonPrefixLength,
  estimateCacheStats,
  estimateTokens,
  estimateUsage,
  formatCacheHitRate,
  formatTokenCount,
  isCjk,
  type TokenUsage,
} from '@domain/value-objects/usage';

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  ...overrides,
});

describe('estimateTokens（全应用唯一的字符↔token 换算）', () => {
  it('空串是 0，不做无意义的取整', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('汉字按 0.7 倍计（贴着实测的散文档，略偏保守）', () => {
    /*
     * 早先是 1.7（"1 字约 1.5~1.7 token"那个旧说法），实测平均高估 89%（见 usage.ts 里的表）。
     * 现在按官方 tokenizer 量出来的 0.7。别按"感觉"把它调大 —— 预算、压缩触发线、
     * "每轮约多少字"全都吃这个系数。
     */
    expect(estimateTokens('你好')).toBe(2); // ceil(2 × 0.7)
    expect(estimateTokens('你好你好')).toBe(3); // ceil(4 × 0.7)
  });

  it('拉丁字符按 4 字符 1 token 计', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('中英混排各算各的', () => {
    expect(estimateTokens('你好abcd')).toBe(3); // ceil(2×0.7 + 4×0.25)
  });

  it('中文标点与全角字符算作汉字', () => {
    expect(isCjk('，')).toBe(true);
    expect(isCjk('。')).toBe(true);
    expect(isCjk('Ａ')).toBe(true);
    expect(isCjk('a')).toBe(false);
    expect(isCjk(' ')).toBe(false);
  });

  it('emoji（代理对）按 2 个 UTF-16 码元进拉丁池，不会因码点判断而漏算', () => {
    // for...of 按码点遍历 → 认不出是汉字 → 落到 other，
    // 而 other 用 text.length 计（代理对算 2），两句合起来得到 1
    expect(estimateTokens('😀')).toBe(1);
  });
});

describe('formatTokenCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1500, '2K'],
    [1_000_000, '1M'],
    [2_000_000, '2M'],
    [1_200_000, '1.2M'],
  ])('%i → %s', (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });

  it('整百万不显示小数点（1M 比 1.0M 干净）', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
  });
});

describe('commonPrefixLength', () => {
  it.each([
    ['abc', 'abd', 2],
    ['abc', 'abc', 3],
    ['', 'abc', 0],
    ['abc', '', 0],
    ['中文x', '中文y', 2],
  ])('%s 与 %s 的公共前缀是 %i', (a, b, expected) => {
    expect(commonPrefixLength(a, b)).toBe(expected);
  });
});

describe('estimateCacheStats', () => {
  it('首次请求（没有基准）命中为 0，这不是错误而是事实', () => {
    const stats = estimateCacheStats('', 'abcde');
    expect(stats.hitTokens).toBe(0);
    expect(stats.missTokens).toBe(estimateTokens('abcde'));
  });

  it('前缀完全一致就是全命中', () => {
    const stats = estimateCacheStats('abcde', 'abcde');
    expect(stats.hitTokens).toBe(estimateTokens('abcde'));
    expect(stats.missTokens).toBe(0);
  });

  it('只往后追加时，追加之前的部分全部命中（提示词缓存的关键性质）', () => {
    const stats = estimateCacheStats('你好', '你好世界');
    expect(stats.hitTokens).toBe(estimateTokens('你好'));
    /*
     * 未命中数由「总量 − 命中」得出，而不是单独估算后缀：
     * 两半各自 `ceil` 过，直接算后缀会与总数对不上（这里 4 + 4 ≠ 7）。
     * 只有"两者相加等于总量"是必须成立的，断言写这个不变量。
     */
    const total = estimateTokens('你好世界');
    expect(stats.hitTokens + stats.missTokens).toBe(total);
    expect(stats.missTokens).toBeGreaterThan(0);
  });

  it('结果一律标记为 estimated —— 估算值绝不能冒充服务端数据', () => {
    expect(estimateCacheStats('a', 'ab').source).toBe('estimated');
  });
});

describe('cacheStatsOf', () => {
  it('服务端没给缓存字段时返回 null（界面不显示，而不是假装 0%）', () => {
    expect(cacheStatsOf(usage())).toBeNull();
  });

  it('服务端给 0 时是"确实一次没命中"，要显示出来', () => {
    // 早期版本把 0 和"缺失"都当成不显示，用户以为功能坏了
    expect(cacheStatsOf(usage({ cachedPromptTokens: 0, cacheSource: 'provider' }))).toEqual({
      hitTokens: 0,
      missTokens: 100,
      source: 'provider',
    });
  });

  it('没标来源时默认按服务端上报处理', () => {
    expect(cacheStatsOf(usage({ cachedPromptTokens: 30 }))?.source).toBe('provider');
  });

  it('估算来源原样带出，供界面加「≈」', () => {
    expect(cacheStatsOf(usage({ cachedPromptTokens: 30, cacheSource: 'estimated' }))?.source).toBe(
      'estimated',
    );
  });

  it('脏数据不至于算出负数：命中数钳到 0，未命中数不为负', () => {
    expect(cacheStatsOf(usage({ cachedPromptTokens: -5 }))).toMatchObject({
      hitTokens: 0,
      missTokens: 100,
    });
    expect(cacheStatsOf(usage({ cachedPromptTokens: 999 }))?.missTokens).toBe(0);
  });
});

describe('命中率显示', () => {
  it.each([
    [{ hitTokens: 78, missTokens: 22, source: 'provider' as const }, 0.78, '78%'],
    [{ hitTokens: 1, missTokens: 3, source: 'provider' as const }, 0.25, '25%'],
    [{ hitTokens: 1, missTokens: 2, source: 'provider' as const }, 1 / 3, '33%'],
  ])('%j → %s', (stats, rate, text) => {
    expect(cacheHitRate(stats)).toBeCloseTo(rate, 5);
    expect(formatCacheHitRate(stats)).toBe(text);
  });

  it('总量为 0 时命中率是 0 而不是 NaN', () => {
    const empty = { hitTokens: 0, missTokens: 0, source: 'provider' as const };
    expect(cacheHitRate(empty)).toBe(0);
    expect(formatCacheHitRate(empty)).toBe('0%');
  });
});

describe('addUsage（一次工具循环的多轮用量要累加）', () => {
  it('缺一边时直接返回另一边', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    const only = usage();
    expect(addUsage(undefined, only)).toBe(only);
    expect(addUsage(only, undefined)).toBe(only);
  });

  it('三项 token 数逐项相加', () => {
    const sum = addUsage(usage({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }), usage({
      promptTokens: 300,
      completionTokens: 50,
      totalTokens: 350,
    }));
    expect(sum).toMatchObject({ promptTokens: 400, completionTokens: 70, totalTokens: 470 });
  });

  it('缓存命中数相加', () => {
    const sum = addUsage(
      usage({ cachedPromptTokens: 30, cacheSource: 'provider' }),
      usage({ cachedPromptTokens: 60, cacheSource: 'provider' }),
    );
    expect(sum?.cachedPromptTokens).toBe(90);
  });

  it('只要有一轮是估算的，整体就只能算估算（不能用精确值把估算洗白）', () => {
    const sum = addUsage(
      usage({ cachedPromptTokens: 30, cacheSource: 'estimated' }),
      usage({ cachedPromptTokens: 60, cacheSource: 'provider' }),
    );
    expect(sum?.cacheSource).toBe('estimated');
  });

  it('两边都没有缓存数据时，结果里也不出现该字段', () => {
    const sum = addUsage(usage(), usage());
    expect(sum?.cachedPromptTokens).toBeUndefined();
    expect('cachedPromptTokens' in (sum ?? {})).toBe(false);
  });

  it('推理 token 同样累加，且只有都不存在时才省略', () => {
    expect(
      addUsage(usage({ reasoningTokens: 5 }), usage({ reasoningTokens: 7 }))?.reasoningTokens,
    ).toBe(12);
    expect(addUsage(usage(), usage())?.reasoningTokens).toBeUndefined();
  });
});

/**
 * 流式期间的估算用量
 *
 * 协议上 usage 随**最后一个 chunk** 才发回，所以那一轮结束前界面上一个数都没有 ——
 * 长回答写完要几分钟，用户会以为"没有统计"（真实反馈）。`estimateUsage` 就是
 * 那段时间的填充物：它必须**明说自己不准确**（`estimated`，界面显示成 `≈`），
 * 而不能冒充服务端数据 —— 与缓存命中率那套约定完全一致。
 */
describe('estimateUsage（流式期间的本地估算）', () => {
  it('拼出 promptTokens + 本地估算的 completionTokens，并且**标记为估算**', () => {
    const estimated = estimateUsage(1000, '一二三四');
    expect(estimated.estimated).toBe(true);
    expect(estimated.completionTokens).toBe(estimateTokens('一二三四'));
    expect(estimated.totalTokens).toBe(1000 + estimated.completionTokens);
  });

  it('正文还是空的也能用（刚开局那一帧）', () => {
    expect(estimateUsage(500, '').totalTokens).toBe(500);
  });

  it('与准确值相加时整体仍算估算 —— 不能用准确值把估算洗白', () => {
    const mixed = addUsage(estimateUsage(100, '一段'), {
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
    });
    expect(mixed?.estimated).toBe(true);
    expect(mixed?.totalTokens).toBe(100 + estimateTokens('一段') + 250);
  });

  it('两边都是准确值时，结果里不出现 estimated（界面据此不显示 ≈）', () => {
    const sum = addUsage(
      { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
    );
    expect(sum?.estimated).toBeUndefined();
    expect('estimated' in (sum ?? {})).toBe(false);
  });
});
