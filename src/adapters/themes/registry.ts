import type {
  CompiledTheme,
  Theme,
  ThemeId,
  ThemeManifest,
  ThemeRegistry,
  ThemeRequest,
} from '@ports/Theme';
import { compileTheme } from './compileTheme';

/**
 * 主题注册表
 *
 * 这是「新增一个主题」的唯一入口（架构文档 ADR-007 / 扩展点 ③）：
 * 新增主题 = 新增一个数据文件 + 在组合根的主题数组里加一项。核心层零改动。
 */
export function createThemeRegistry(initial: readonly Theme[] = []): ThemeRegistry {
  const themes = new Map<ThemeId, Theme>();
  let fallbackId: ThemeId | null = null;

  const register = (theme: Theme): void => {
    const existed = themes.has(theme.id);
    themes.set(theme.id, theme);
    if (fallbackId === null || !existed) {
      // 首个注册的主题即兜底主题：即使偏好指向一个已被删除的主题，也不会白屏
      if (fallbackId === null) fallbackId = theme.id;
    }
  };

  for (const theme of initial) register(theme);

  const get = (id: ThemeId): Theme | undefined => themes.get(id);

  const list = (): ThemeManifest[] =>
    [...themes.values()].map((theme) => ({
      id: theme.id,
      name: theme.name,
      version: theme.version,
      colorScheme: theme.colorScheme,
      ...(theme.meta?.description ? { description: theme.meta.description } : {}),
    }));

  const resolve = (request: ThemeRequest): Theme => {
    if (request.preference !== 'system') {
      const exact = themes.get(request.preference);
      if (exact) return exact;
      // 偏好指向的主题不存在（例如被卸载）→ 静默降级到兜底主题
    }

    const wanted = request.prefersDark ? 'dark' : 'light';
    for (const theme of themes.values()) {
      if (theme.colorScheme === wanted) return theme;
    }

    const fallback = fallbackId !== null ? themes.get(fallbackId) : undefined;
    if (!fallback) throw new Error('[theme] 主题注册表为空，至少需要注册一个主题');
    return fallback;
  };

  const compile = (theme: Theme): CompiledTheme => compileTheme(theme);

  return { register, get, list, resolve, compile };
}
