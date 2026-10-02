import type { ThemePreference } from '@ports/Theme';

/**
 * 主题偏好的快速通道存储
 *
 * 为什么这里用 localStorage 而不是 SQLite？
 * 因为 index.html 里有一段内联脚本，必须在**首屏渲染前**就知道用哪套主题，
 * 否则会闪一下白屏（FOUC）。这是设备级 UI 偏好，不是业务数据，放 localStorage 是合适的。
 *
 * 注意：key 必须与 index.html 内联脚本中读取的 key 保持一致。
 */
export const THEME_STORAGE_KEY = 'braid.theme';

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    // 这里允许任意非空字符串：注册表会对"未知主题 id"做静默降级，
    // 因此不必在此处维护一份主题白名单（主题是可插拔的）。
    if (raw && raw.trim().length > 0) return raw as ThemePreference;
  } catch {
    // 隐私模式等场景下 localStorage 不可用，忽略即可
  }
  return 'system';
}

/**
 * 写入主题偏好
 *
 * 返回是否成功。早先这里 `catch {}` 吞掉失败，后果是**下次打开应用主题又变回去** ——
 * 用户明明每次都选了同一套，却总被重置，而且没有任何解释。
 * 调用方（`uiStore.setThemePreference`）据此告诉他这一次没能记住。
 */
export function writeThemePreference(preference: ThemePreference): boolean {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}
