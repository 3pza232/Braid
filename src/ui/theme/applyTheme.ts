import type { CompiledTheme, ColorScheme, ThemeId } from '@ports/Theme';

const appliedKeys = new Set<string>();

/** 强调色覆盖会连带派生出的几个变量 */
function accentOverrides(color: string): Record<string, string> {
  return {
    '--color-accent-default': color,
    '--color-accent-hover': `color-mix(in srgb, ${color} 86%, #000)`,
    '--color-accent-active': `color-mix(in srgb, ${color} 72%, #000)`,
    '--color-accent-subtle': `color-mix(in srgb, ${color} 14%, transparent)`,
    '--color-border-focus': color,
  };
}

/**
 * 把编译好的主题写入 :root
 *
 * 只做「设置 CSS 变量 + 标记 colorScheme」两件事，
 * 因此切换主题的成本与主题数量无关，也不会触发 React 重渲染。
 *
 * `accentOverride` 是用户在设置里自定义的强调色：
 * 它是**主题之上的个人覆盖**，不修改主题数据本身，
 * 所以切回默认主题时只要清空这个值即可，不需要动任何主题文件。
 */
export function applyTheme(
  compiled: CompiledTheme,
  themeId: ThemeId,
  colorScheme: ColorScheme,
  accentOverride = '',
  /** 用户逐项覆盖的语义颜色，key 已是 CSS 变量名（见 ThemeProvider 的换算） */
  colorOverrides: Record<string, string> = {},
): void {
  const root = document.documentElement;

  for (const [name, value] of Object.entries(compiled.cssVariables)) {
    root.style.setProperty(name, value);
    appliedKeys.add(name);
  }

  // 用户覆盖**最后写入**才能生效：它在主题之上，是离用户最近的一层
  for (const [name, value] of Object.entries(colorOverrides)) {
    root.style.setProperty(name, value);
    appliedKeys.add(name);
  }

  // 清理上一次主题/覆盖留下、本次没有的变量，避免"幽灵 token"残留
  for (const name of appliedKeys) {
    if (!(name in compiled.cssVariables) && !(name in colorOverrides)) {
      root.style.removeProperty(name);
      appliedKeys.delete(name);
    }
  }

  const accent = accentOverride.trim();
  if (accent) {
    for (const [name, value] of Object.entries(accentOverrides(accent))) {
      root.style.setProperty(name, value);
      appliedKeys.add(name);
    }
  }

  root.dataset['theme'] = colorScheme;
  root.dataset['themeId'] = themeId;
  root.style.colorScheme = colorScheme;
}
