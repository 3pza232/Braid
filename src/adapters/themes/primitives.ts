import type { PaletteTokens, ThemeTokens } from '@ports/Theme';

/**
 * 第 1 层 Token：原始色阶
 *
 * 白天 / 黑夜共用同一套色阶（只是语义映射不同），
 * 这样未来加第三套主题时，色阶可以直接复用。
 */
export const palette: PaletteTokens = {
  gray: {
    '0': '#FFFFFF',
    '50': '#F8FAFC',
    '100': '#F1F5F9',
    '200': '#E2E8F0',
    '300': '#CBD5E1',
    '400': '#94A3B8',
    '500': '#64748B',
    '600': '#475569',
    '700': '#334155',
    '800': '#1E293B',
    '900': '#0F172A',
    '950': '#020617',
  },
  brand: {
    '50': '#EFF6FF',
    '100': '#DBEAFE',
    '300': '#93C5FD',
    '500': '#3B82F6',
    '600': '#2563EB',
    '700': '#1D4ED8',
  },
  red: { '100': '#FEE2E2', '400': '#F87171', '600': '#DC2626' },
  amber: { '100': '#FEF3C7', '400': '#FBBF24', '600': '#D97706' },
  green: { '100': '#DCFCE7', '400': '#4ADE80', '600': '#16A34A' },
};

/**
 * 与配色无关的 token（字体、间距、圆角、阴影、动效、层级）
 *
 * 这些同样放进主题里，而不是写死在全局 CSS，
 * 是为了让"未来某个主题想用衬线正文"这种需求不需要改组件。
 */
export const baseTokens: Pick<
  ThemeTokens,
  'typography' | 'spacing' | 'radius' | 'shadow' | 'motion' | 'zIndex'
> = {
  typography: {
    fontFamily: {
      sans: `"Inter", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif`,
      serif: `"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif`,
      mono: `"JetBrains Mono", "Cascadia Code", "Consolas", "Microsoft YaHei Mono", monospace`,
    },
    fontSize: {
      xs: '12px',
      sm: '13px',
      base: '14px',
      lg: '16px',
      xl: '20px',
      '2xl': '26px',
    },
    fontWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    lineHeight: { tight: 1.25, snug: 1.4, normal: 1.6, relaxed: 1.8 },
    letterSpacing: { tight: '-0.01em', normal: '0', wide: '0.02em' },
  },
  spacing: {
    '0': '0px',
    '1': '4px',
    '2': '8px',
    '3': '12px',
    '4': '16px',
    '5': '20px',
    '6': '24px',
    '8': '32px',
    '10': '40px',
    '12': '48px',
    '16': '64px',
  },
  radius: {
    none: '0px',
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    full: '999px',
  },
  shadow: {
    none: 'none',
    sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
    md: '0 4px 12px rgba(15, 23, 42, 0.08)',
    lg: '0 12px 32px rgba(15, 23, 42, 0.14)',
    inner: 'inset 0 1px 2px rgba(15, 23, 42, 0.06)',
  },
  motion: {
    duration: { instant: '60ms', fast: '120ms', normal: '200ms', slow: '320ms' },
    easing: {
      standard: 'cubic-bezier(0.2, 0, 0.2, 1)',
      decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
      accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
    },
  },
  zIndex: {
    base: 0,
    dropdown: 100,
    sticky: 200,
    overlay: 300,
    modal: 400,
    toast: 500,
    tooltip: 600,
  },
};
