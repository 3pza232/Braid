/**
 * 构建期注入的版本号
 *
 * 由 `vite.config.ts` / `vitest.config.ts` 的 `define` 从 `package.json` 读入。
 * 于是版本号只有**一个来源**（package.json）—— 以前"关于"页里那份硬编码
 * 会随着发版忘记更新，界面上显示的版本与包里的不一致，排查问题时会误导人。
 *
 * （Vitest 也必须注入：面板的冒烟测试会渲染「关于」分区，
 *   否则那里会直接 `__APP_VERSION__ is not defined` 崩掉。）
 */
declare const __APP_VERSION__: string;
