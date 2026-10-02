/**
 * 主题 token 路径 → CSS 变量名
 *
 * 【为什么这条规则必须只有一份】
 * 它有两个调用方，而且**必须得出同一个名字**：
 *  - 主题编译器（`adapters/themes/compileTheme`）把主题 JSON 摊平成 CSS 变量；
 *  - 界面里的"逐项自定义颜色"（`ui/theme/ThemeProvider`）把用户覆盖写成同一批变量。
 *
 * 两处各写一遍正则，只要有一处漂移（比如少 replace 一个 `.`），用户的自定义颜色
 * 就会写到一个**没人用的变量名**上 —— 界面毫无变化、也没有任何报错，
 * 用户只会觉得"我改了颜色但没生效"。属于典型的"平行真相"。
 *
 * 例子：`role.userBubble` → `role-user-bubble`（前缀由调用方加，通常是 `--color`）。
 */
export function themeTokenName(value: string): string {
  return value
    .replace(/\./g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}
