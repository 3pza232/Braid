import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { builtinThemes } from '@adapters/themes';
import { resolveThemeFile } from '@domain/rules/themeInheritance';
import type { Theme } from '@ports/Theme';

/**
 * 仓库里的主题文件（`themes/*.json`）
 *
 * 【为什么值得单独钉住】主题是**数据**：少一个括号、`colorScheme` 写错、id 与别人的撞了，
 * 都不会让构建失败 —— 解析失败只会在控制台 `warn` 一句然后**跳过那一个**
 * （见 `externalThemes`：一个坏文件不该连累别的）。代价是"我明明放了主题，列表里却看不到"。
 * 而主题恰恰是最容易被手改的东西（调颜色不用碰代码），所以这条守住四件事：
 *  1. 每个文件都能被解析（`id` / `name` / `colorScheme` / `extends` / `tokens` 都对）；
 *  2. `extends` 与 `colorScheme` 一致（深色必须接 `braid.dark`）—— 运行时那条路径是**按
 *     colorScheme 找基座**的，对不上就会装出一个"自称浅色的深色主题"；
 *  3. id 不重复、也不与内置主题撞车；
 *  4. token 是**深合并后**的完整结果，而不是只有自己写的那几个键。
 *
 * 【为什么直连 `resolveThemeFile`，而不走 `loadExternalThemes()`】
 * 加载器遇到坏文件会 `console.warn`，而那句日志会撞上 vitest 的 console 拦截器
 * （没有"当前用例"上下文时它自己抛 `Cannot read properties of undefined (reading 'config')`，
 * 整个文件连一条用例都收集不到 —— 真踩到了，探针第一次就是这么报的）。
 * 直连解析既能拿到 `reason` 写进断言消息，也不碰那套日志拦截。
 * 至于装载行为本身，`runtimeThemes.test.ts` 已经覆盖，而且两条路径共用同一段校验代码。
 */
/*
 * 末尾那个斜杠是必须的：`new URL('x.json', base)` 把 base 当**文件**解析，
 * 少了它就会去项目根目录找 catppuccin-latte.json（ENOENT，踩了一次）
 */
const THEMES_DIR = new URL('../../themes/', import.meta.url);

const FILES = readdirSync(THEMES_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

/** 逐份文件解析一遍；结果带着 reason，坏文件会在断言里指名道姓 */
const parsed = FILES.map((file) => {
  const raw: unknown = JSON.parse(readFileSync(new URL(file, THEMES_DIR), 'utf8'));
  const extendsId = (raw as { extends?: unknown } | null)?.extends;
  const base = builtinThemes.find((theme) => theme.id === extendsId);
  if (!base) {
    return { file, raw, base: null, result: null as ReturnType<typeof resolveThemeFile> | null };
  }
  return { file, raw, base, result: resolveThemeFile(raw, base) };
});

/** 语义层的分组名（bg / text / border / accent / status / role / diff / …） */
const semanticGroupsOf = (theme: Theme): string[] => Object.keys(theme.tokens.semantic);

describe('仓库里的主题文件（themes/*.json）', () => {
  it('目录里确实有主题（少到没有了就该有人看一眼）', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES)('%s 能被解析', (file) => {
    const entry = parsed.find((item) => item.file === file);
    expect(entry, `${file} 没有被读到`).toBeTruthy();
    // extends 指不到任何内置基座时，加载器整份跳过 —— 这里直接指出是哪个文件
    expect(
      entry?.base,
      `${file} 的 extends 指向了不存在的基础主题（只能是 ${builtinThemes
        .map((theme) => theme.id)
        .join(' / ')}）`,
    ).toBeTruthy();
    expect(
      entry?.result?.ok,
      `${file} 解析失败：${entry?.result && !entry.result.ok ? entry.result.reason : '未知原因'}`,
    ).toBe(true);
  });

  it.each(FILES)('%s 的 extends 与 colorScheme 一致（深色只能接 braid.dark）', (file) => {
    const raw = parsed.find((item) => item.file === file)?.raw as {
      colorScheme?: unknown;
      extends?: unknown;
    };
    const expected = raw?.colorScheme === 'dark' ? 'braid.dark' : 'braid.light';
    expect(raw?.extends, `${file} 的 colorScheme 与 extends 对不上`).toBe(expected);
  });

  it('id 不重复，也不与内置主题撞车', () => {
    const ids = parsed.flatMap((item) => (item.result?.ok ? [item.result.theme.id] : []));
    expect(new Set(ids).size).toBe(ids.length);

    const builtinIds = new Set<string>(builtinThemes.map((theme) => theme.id));
    for (const id of ids) {
      expect(builtinIds.has(id), `${id} 与内置主题重名`).toBe(false);
    }
  });

  it('每份都写全了语义 token，不是空壳', () => {
    for (const item of parsed) {
      if (!item.result?.ok) continue;
      const theme = item.result.theme as Theme;
      const groups = semanticGroupsOf(theme);
      expect(groups.length, `${item.file} 的语义 token 太少`).toBeGreaterThanOrEqual(8);
      expect(groups).toContain('role');
      expect(groups).toContain('accent');
      expect(groups).toContain('bg');
    }
  });

  it('深色 / 浅色都有得选', () => {
    const schemes = parsed.flatMap((item) =>
      item.result?.ok ? [item.result.theme.colorScheme] : [],
    );
    expect(schemes).toContain('dark');
    expect(schemes).toContain('light');
  });
});
