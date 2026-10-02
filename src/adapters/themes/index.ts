export { palette, baseTokens } from './primitives';
export { lightTheme } from './light';
export { darkTheme } from './dark';
export { compileTheme } from './compileTheme';
export { createThemeRegistry } from './registry';

import { darkTheme } from './dark';
import { lightTheme } from './light';

/**
 * 内置主题清单
 *
 * 新增主题时只需要在这里加一项 —— 这是「扩展点 ③」的全部改动量。
 */
export const builtinThemes = [lightTheme, darkTheme];
