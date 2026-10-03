# 主题与样式

## Token 分层

```
--p-*         第 1 层：原始色阶（primitive）—— **组件禁止引用**
--color-*     第 2 层：语义色（semantic）—— 组件唯一允许引用的颜色来源
--font-* / --text-* / --weight-* / --leading-* / --tracking-*   字体
--space-* / --radius-* / --shadow-*                             尺寸与阴影
--duration-* / --ease-*                                          动效
--z-*                                                            层叠
```

变量由 `compileTheme(theme)` 从主题对象摊平产出，再经 `applyTheme` 写到 `:root`，
同时设置 `data-theme` / `data-theme-id` / `color-scheme`。

**命名规则只有一份**：token 路径 → 变量名（`role.userBubble` → `--color-role-user-bubble`）
走 `domain/value-objects/themeToken.ts`。主题编译器与界面里的"逐项自定义颜色"都用它 ——
两处各写一遍正则的话，只要有一处漂移，用户的覆盖就会写到一个没人用的变量上：
改了颜色却毫无变化、也不报错。

**纪律**：任何样式文件里都不许出现硬编码颜色（`global.css` 顶部就写着这条）。
换主题不需要改任何组件，全靠这条。

## z-index 刻度（**必须用 token**）

| token | 值 | 用在哪 |
|---|---|---|
| `--z-base` | 0 | 环境级浮动控件（消息区的"回到最上/最新"） |
| `--z-dropdown` | 100 | 下拉、上下文菜单、气泡确认 |
| `--z-sticky` | 200 | 吸顶/吸底 |
| `--z-overlay` | 300 | 遮罩 |
| `--z-modal` | 400 | 面板（设置、角色、会话设置） |
| `--z-toast` | 500 | 临时提示 |
| `--z-tooltip` | 600 | 悬浮说明 |

**`check:styles` 会拦下裸数字 z-index 和不存在的 token 名**（硬编码的合法集合就是上表）。
这条门禁是踩坑后的产物：一个硬编码的 `z-index: 6` 让消息区的浮动按钮盖住了设置面板 ——
点击"没反应"，因为滚动的是被面板挡住的消息区，而代码上完全看不出来。

配套的结构性防护：消息区 `.scroller` 上写了 `position: relative; isolation: isolate`，
**自成层叠上下文** —— 里面的东西再怎么写 z-index 也盖不住应用级的覆盖层。

## 主题文件

- 放**项目根 `themes/*.json`**（Vite `import.meta.glob('/themes/*.json')` 收集）：
  自带 6 个（`contrast` / `neon` / `ocean` / `sakura` / `sepia` / `terminal`）
  与取自流行编辑器配色的 5 个（`gruvbox` / `catppuccin-mocha` / `catppuccin-latte` /
  `nord` / `solarized-light`）。同目录那份 `README.md` 不参与收集，是给这个目录自己解释自己用的；
- **深浅要配平**：`colorScheme` 与 `extends` 必须一致（深色只能接 `braid.dark`）——
  运行时那条路径是**按 colorScheme 找基座**的，对不上会装出一个"自称浅色的深色主题"。
  `tests/adapters/bundledThemes.test.ts` 逐份守住这条，以及 id 不重复、语义层不残缺；
- 每个文件**必须写** `"extends": "braid.light"` 或 `"braid.dark"`，自己只放**覆盖项**；
- 深合并在 `domain/rules/themeInheritance.ts`（纯函数，有单测）；坏文件跳过并 `console.warn`，
  不会让整个应用起不来。

加一个主题：在 `themes/` 放一个 JSON（`extends` + 想改的 token），重启 dev 即可出现在主题下拉里。

### 桌面版：可拔插的主题目录

打包后的应用还能从 **exe 同级的 `themes/`** 读主题。这个目录**在安装时就铺好了** ——
安装器的 `customInstall` 宏把 `resources/themes/`（electron-builder 的 `extraResources`，
在 asar 之外）拷到 exe 同级，不用等第一次运行（见 `electron/installer.nsh`）。
主进程里那份 `ensureThemeDirectory()` 退居**兜底**（开发态、以及用户把整个目录删了之后）：

- 放一个 `.json` 进去、重启应用 → 设置里就能选到，不必改代码、也不必重新打包；
- 删掉文件 → 真的没了。**有运行时目录时只听目录里的**，不会退回打包进应用的示例；
- **两种来源不会合并**：合并的话"删掉文件却还在"会变成没有答案的困惑，而那正是这个
  功能要解决的问题。所以 `loadRuntimeThemes` 用 `null` 表示"没有目录"、`[]` 表示"目录是空的"；
- 普通浏览器里没有这个目录，仍用打包的那批（行为与以前一致）。

渲染进程读不到磁盘，文件由桌面壳的本地服务端出来（`/_external-themes`，见
[07-development.md](./07-development.md)）；加载发生在挂载 React 之前，因为主题注册表
不通知订阅者 —— 挂载后再注册，用户得刷新一次才看得到新主题。

## 用户自定义颜色

设置 → 主题 → 「主题颜色」：按组列出全部语义色，可逐个改、可一键恢复。
改动以"最后写入"的方式覆盖 CSS 变量，并会清理"幽灵 token"（上一版遗留、这一版已不存在的变量）。

## CSS Module 纪律

- 组件用 `*.module.css` + `import styles from './X.module.css'`；
- 全局样式只有三个：`ui/styles/global.css`（基础重置）、`highlight.css`（代码高亮）、
  `searchHighlight.css`（搜索高亮的 `::highlight` 伪元素）——
  **后两者的名字是运行时注册的，放进 CSS Module 等于没写**；
- `check:styles` 两者都拦：代码里用了 `styles.x` 但 CSS 里没定义、以及定义了没人用的**死样式**
  （确实要留就在那一行写 `/* @dead-style-ok: 理由 */`，见 [07-development.md](./07-development.md)）。

## 防闪烁

`index.html` 里有一段内联脚本：在首帧之前读 `localStorage['braid.theme']` +
`matchMedia('(prefers-color-scheme: dark)')`，先给 `<html>` 设好 `data-theme`。
否则深色偏好下会先闪一下白底。
