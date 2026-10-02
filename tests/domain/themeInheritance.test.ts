import { describe, expect, it } from 'vitest';
import { mergeTokens, resolveThemeFile } from '@domain/rules/themeInheritance';
import type { Theme, ThemeTokens } from '@ports/Theme';

/**
 * 用内联的最小基础主题，而不是引入内置主题适配器 ——
 * 本文件在 tests/domain/ 下，只能依赖 domain 与 shared（分层检查按目录名判定）。
 * 合并规则对 token 的**形状**没有要求，所以一个两三个字段的假主题足够了。
 */
const base = {
  id: 'braid.dark',
  name: '黑夜',
  version: '1.0.0',
  colorScheme: 'dark',
  tokens: {
    semantic: {
      accent: { default: '#000000', hover: '#111111' },
      bg: { canvas: '#101010' },
      text: { primary: '#EEEEEE' },
      selection: 'rgba(255,255,255,0.2)',
    },
    spacing: { '3': '12px' },
  },
} as unknown as Theme;

const minimal = {
  id: 'my-theme',
  name: '我的主题',
  version: '1.0.0',
  colorScheme: 'dark',
  extends: 'braid.dark',
  tokens: {
    semantic: {
      accent: { default: '#FF6600' },
      role: { userBubble: '#123456' },
    },
  },
};

describe('外置主题文件解析', () => {
  it('合法的覆盖文件：只写的 token 覆盖，其余继承基础主题', () => {
    const result = resolveThemeFile(minimal, base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.id).toBe('my-theme');
    // 层级：tokens.semantic.bg.canvas —— role/accent/bg 都在 semantic 下面
    const tokens = result.theme.tokens as {
      semantic: Record<string, unknown>;
      spacing: unknown;
    };
    const semantic = tokens.semantic as Record<string, unknown>;
    expect(semantic.role).toEqual({ userBubble: '#123456' });
    expect(semantic.accent).toMatchObject({ default: '#FF6600', hover: '#111111' });
    expect(semantic.bg).toMatchObject({ canvas: '#101010' });
    expect(semantic.text).toMatchObject({ primary: '#EEEEEE' });
    expect(semantic.selection).toBe('rgba(255,255,255,0.2)');
    expect(tokens.spacing).toEqual({ '3': '12px' });
    expect(result.theme.meta?.extends).toBe('braid.dark');
  });

  it('深层合并不丢兄弟字段：改 accent.default 不影响 accent.hover', () => {
    const result = resolveThemeFile(minimal, base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const semantic = (result.theme.tokens as { semantic: Record<string, unknown> }).semantic;
    expect(semantic.accent).toMatchObject({ default: '#FF6600', hover: '#111111' });
  });

  it.each([
    ['不是对象', 'not-an-object'],
    [{ name: 'x', colorScheme: 'dark', extends: 'braid.dark', tokens: {} }, 'missing-id'],
    [{ id: 'x', colorScheme: 'dark', extends: 'braid.dark', tokens: {} }, 'missing-name'],
    [
      { id: 'x', name: 'x', colorScheme: 'sepia', extends: 'braid.dark', tokens: {} },
      'bad-color-scheme',
    ],
    [{ id: 'x', name: 'x', colorScheme: 'dark', extends: 'nope', tokens: {} }, 'unknown-base'],
    [{ id: 'x', name: 'x', colorScheme: 'dark', extends: 'braid.dark' }, 'missing-tokens'],
  ])('非法文件被拒绝 → %s', (raw, reason) => {
    const result = resolveThemeFile(raw, base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('version 缺省时给 1.0.0', () => {
    const { version: _version, ...withoutVersion } = minimal;
    const result = resolveThemeFile(withoutVersion, base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.version).toBe('1.0.0');
  });
});

describe('token 深合并', () => {
  it('对象递归、标量整体覆盖', () => {
    const source = { a: { b: 1, c: 2 }, d: 'x' };
    expect(mergeTokens(source, { a: { b: 9 } })).toEqual({ a: { b: 9, c: 2 }, d: 'x' });
    expect(mergeTokens(source, { d: 'y' })).toEqual({ a: { b: 1, c: 2 }, d: 'y' });
  });

  it('非对象覆盖值直接替换（不与对象合并）', () => {
    expect(mergeTokens({ a: { b: 1 } }, { a: 'text' })).toEqual({ a: 'text' });
  });

  it('覆盖 undefined 时保留基础值', () => {
    const tokens = { a: 'x' } as unknown as ThemeTokens;
    expect(mergeTokens(tokens, { a: undefined })).toEqual({ a: 'x' });
  });
});
