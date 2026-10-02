import { describe, expect, it } from 'vitest';
import { matchesQuery } from '@domain/rules/fuzzyMatch';

describe('会话标题近似匹配', () => {
  it('空查询不过滤', () => {
    expect(matchesQuery('任何标题', '')).toBe(true);
    expect(matchesQuery('任何标题', '   ')).toBe(true);
  });

  it('连续子串命中', () => {
    expect(matchesQuery('修钟人', '修钟')).toBe(true);
    expect(matchesQuery('重构 braid 的存储层', 'braid')).toBe(true);
  });

  it('按顺序的子序列也命中（少打几个字也能找到）', () => {
    expect(matchesQuery('修钟人', '钟人')).toBe(true);
    expect(matchesQuery('修钟人', '修人')).toBe(true);
  });

  it('顺序乱了不命中：宁可不命中，也不要一堆不相关的结果', () => {
    expect(matchesQuery('修钟人', '人钟')).toBe(false);
  });

  it('大小写与空格不参与比较', () => {
    expect(matchesQuery('AI 写作助手', 'ai写作')).toBe(true);
    expect(matchesQuery('Rust 所有权', 'rust')).toBe(true);
  });

  it('完全不相关的不命中', () => {
    expect(matchesQuery('修钟人', '世界观设定')).toBe(false);
  });
});
