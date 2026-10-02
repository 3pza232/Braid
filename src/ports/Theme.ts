import type { ThemeId } from '@shared/ids';

export type { ThemeId };

/**
 * 主题端口
 *
 * 设计要点（详见 docs/05-theme.md）：
 *  1. 主题是**纯数据**（一个 TS/JSON 对象），不是 CSS 文件。新增主题 = 新增 1 个数据文件 + 注册 1 行。
 *  2. Design Token 分两层：primitive（原始色阶）→ semantic（语义）。
 *     **组件只允许引用 semantic 层**，因此换主题永远不需要改组件。
 *     （最初的设计里还打算加一层 component，实际没有落地数据 —— 写在注释里只会让人去找它。）
 *  3. 注入方式是 CSS 变量 + `:root[data-theme]`，切换成本 = 改一个属性，不做整页重渲染。
 */

export type ColorScheme = 'light' | 'dark';

export type GrayStep =
  | '0'
  | '50'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900'
  | '950';

export type BrandStep = '50' | '100' | '300' | '500' | '600' | '700';
export type StatusStep = '100' | '400' | '600';

/** 第 1 层：原始色阶。不允许组件直接引用（CI 可加规则扫描） */
export interface PaletteTokens {
  gray: Record<GrayStep, string>;
  brand: Record<BrandStep, string>;
  red: Record<StatusStep, string>;
  amber: Record<StatusStep, string>;
  green: Record<StatusStep, string>;
}

/** 第 2 层：语义层。组件只允许引用这一层 */
export interface SemanticTokens {
  bg: {
    canvas: string;
    surface: string;
    raised: string;
    sunken: string;
    overlay: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    disabled: string;
    inverse: string;
    link: string;
  };
  border: {
    subtle: string;
    default: string;
    strong: string;
    focus: string;
  };
  accent: {
    default: string;
    hover: string;
    active: string;
    subtle: string;
    onAccent: string;
  };
  status: {
    info: string;
    success: string;
    warning: string;
    danger: string;
    onStatus: string;
  };
  role: {
    userBubble: string;
    userText: string;
    assistantBubble: string;
    assistantText: string;
    systemBubble: string;
    systemText: string;
    toolBubble: string;
    toolText: string;
  };
  diff: {
    add: string;
    addText: string;
    del: string;
    delText: string;
    gutter: string;
  };
  selection: string;
  caret: string;
  scrollbarThumb: string;
  scrollbarTrack: string;
}

export interface TypographyTokens {
  fontFamily: { sans: string; serif: string; mono: string };
  fontSize: Record<'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl', string>;
  fontWeight: Record<'regular' | 'medium' | 'semibold' | 'bold', number>;
  lineHeight: Record<'tight' | 'snug' | 'normal' | 'relaxed', number>;
  letterSpacing: Record<'tight' | 'normal' | 'wide', string>;
}

export interface ThemeTokens {
  primitive: PaletteTokens;
  semantic: SemanticTokens;
  typography: TypographyTokens;
  spacing: Record<'0' | '1' | '2' | '3' | '4' | '5' | '6' | '8' | '10' | '12' | '16', string>;
  radius: Record<'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full', string>;
  shadow: Record<'none' | 'sm' | 'md' | 'lg' | 'inner', string>;
  motion: {
    duration: Record<'instant' | 'fast' | 'normal' | 'slow', string>;
    easing: Record<'standard' | 'decelerate' | 'accelerate', string>;
  };
  zIndex: Record<'base' | 'dropdown' | 'sticky' | 'overlay' | 'modal' | 'toast' | 'tooltip', number>;
}

export interface Theme {
  readonly id: ThemeId;
  readonly name: string;
  readonly version: string;
  readonly colorScheme: ColorScheme;
  readonly tokens: ThemeTokens;
  readonly meta?: {
    author?: string;
    description?: string;
    /** 未来主题市场用：继承另一个主题并覆盖部分 token */
    extends?: ThemeId;
  };
}

export interface CompiledTheme {
  /** 形如 { '--color-text-primary': '#0F172A', '--space-3': '12px' } */
  cssVariables: Record<string, string>;
  /** 供原生窗口同步使用（桌面壳可据此设置窗口标题栏配色等） */
  nativeHints: {
    background: string;
    foreground: string;
    colorScheme: ColorScheme;
  };
}

export interface ThemeManifest {
  id: ThemeId;
  name: string;
  version: string;
  colorScheme: ColorScheme;
  description?: string;
}

/** 用户在设置里的选择：具体主题 id 或「跟随系统」 */
export type ThemePreference = ThemeId | 'system';

export interface ThemeRequest {
  preference: ThemePreference;
  prefersDark: boolean;
}

export interface ThemeRegistry {
  /** 扩展点：注册一个主题。新增主题时核心层零改动 */
  register(theme: Theme): void;
  get(id: ThemeId): Theme | undefined;
  list(): ThemeManifest[];
  /** 解析 'system' 并返回最终生效的主题 */
  resolve(request: ThemeRequest): Theme;
  /** 主题 → CSS 变量表 */
  compile(theme: Theme): CompiledTheme;
}
