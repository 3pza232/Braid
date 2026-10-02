import { themeTokenName } from '@domain/value-objects/themeToken';
import type { CompiledTheme, Theme } from '@ports/Theme';

type Bucket = Record<string, string | Record<string, string | number>>;

/**
 * 把一个分组的 token 摊平成 CSS 变量。
 * 支持一层嵌套（如 semantic.bg.canvas）与扁平的字符串值（如 semantic.selection）。
 */
function emitGroup(
  vars: Record<string, string>,
  prefix: string,
  group: Bucket,
): void {
  for (const [key, value] of Object.entries(group)) {
    if (typeof value === 'string') {
      vars[`${prefix}-${themeTokenName(key)}`] = value;
    } else {
      for (const [subKey, subValue] of Object.entries(value)) {
        vars[`${prefix}-${themeTokenName(key)}-${themeTokenName(subKey)}`] = String(subValue);
      }
    }
  }
}

/**
 * 主题 → CSS 变量表
 *
 * 命名规范（详见 [docs/05-theme.md](../../docs/05-theme.md)）：
 *  - `--p-*`       第 1 层 原始色阶（禁止组件引用）
 *  - `--color-*`   第 2 层 语义颜色（组件唯一允许引用的颜色来源）
 *  - `--font-* / --text-* / --weight-* / --leading-* / --tracking-*`  字体
 *  - `--space-* / --radius-* / --shadow-* / --duration-* / --ease-* / --z-*`
 */
export function compileTheme(theme: Theme): CompiledTheme {
  const t = theme.tokens;
  const vars: Record<string, string> = {};

  emitGroup(vars, '--p', t.primitive as unknown as Bucket);
  emitGroup(vars, '--color', t.semantic as unknown as Bucket);

  emitGroup(vars, '--font', t.typography.fontFamily as unknown as Bucket);
  emitGroup(vars, '--text', t.typography.fontSize as unknown as Bucket);
  emitGroup(vars, '--weight', t.typography.fontWeight as unknown as Bucket);
  emitGroup(vars, '--leading', t.typography.lineHeight as unknown as Bucket);
  emitGroup(vars, '--tracking', t.typography.letterSpacing as unknown as Bucket);

  emitGroup(vars, '--space', t.spacing as unknown as Bucket);
  emitGroup(vars, '--radius', t.radius as unknown as Bucket);
  emitGroup(vars, '--shadow', t.shadow as unknown as Bucket);

  emitGroup(vars, '--duration', t.motion.duration as unknown as Bucket);
  emitGroup(vars, '--ease', t.motion.easing as unknown as Bucket);
  emitGroup(vars, '--z', t.zIndex as unknown as Bucket);

  return {
    cssVariables: vars,
    nativeHints: {
      background: t.semantic.bg.canvas,
      foreground: t.semantic.text.primary,
      colorScheme: theme.colorScheme,
    },
  };
}
