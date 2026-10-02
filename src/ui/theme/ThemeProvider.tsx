import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { themeTokenName } from '@domain/value-objects/themeToken';
import type { Theme, ThemeManifest, ThemePreference } from '@ports/Theme';
import { useUiStore } from '@ui/stores/uiStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { applyTheme } from './applyTheme';

interface ThemeContextValue {
  /** 当前实际生效的主题（'system' 已被解析为具体主题） */
  theme: Theme;
  themes: ThemeManifest[];
  /** 用户在设置里的原始选择，可能是 'system' */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeProviderProps {
  children: ReactNode;
  themes: import('@ports/Theme').ThemeRegistry;
}

export function ThemeProvider({ children, themes: registry }: ThemeProviderProps) {
  const preference = useUiStore((s) => s.themePreference);
  const setPreference = useUiStore((s) => s.setThemePreference);

  const [prefersDark, setPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(DARK_QUERY).matches
      : false,
  );

  // 跟随系统：监听系统配色变化（含用户在 OS 里切换时实时响应）
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setPrefersDark(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const theme = useMemo(
    () => registry.resolve({ preference, prefersDark }),
    [registry, preference, prefersDark],
  );

  // 用户在设置里自定义的强调色：主题之上的个人覆盖，不修改主题数据本身
  const accentColor = useSettingsStore((s) => s.settings.appearance.accentColor);
  // 用户逐项覆盖的语义颜色（气泡 / 面板 / 进度条……任何语义色）
  const customColors = useSettingsStore((s) => s.settings.appearance.customColors);

  /*
   * token 路径（role.userBubble）→ CSS 变量名（--color-role-user-bubble）
   *
   * 命名规则走 `themeTokenName`（与主题编译器共用同一份）—— 两处各写一遍正则的话，
   * 只要有一处漂移，用户的覆盖就写到一个没人用的变量上：改了颜色却毫无变化。
   */
  const colorOverrides = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [path, value] of Object.entries(customColors)) {
      out[`--color-${themeTokenName(path)}`] = value;
    }
    return out;
  }, [customColors]);

  // 只在主题/覆盖真正变化时写入 CSS 变量；切换成本与主题数量无关
  useEffect(() => {
    applyTheme(registry.compile(theme), theme.id, theme.colorScheme, accentColor, colorOverrides);
  }, [registry, theme, accentColor, colorOverrides]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themes: registry.list(),
      preference,
      setPreference,
    }),
    [theme, registry, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('[theme] useTheme 必须在 <ThemeProvider> 内使用');
  return ctx;
}
