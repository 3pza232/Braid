# Braid

本地优先的 AI 对话工作台。数据存在浏览器的 **OPFS** 里（SQLite 编译为 WASM，跑在 Worker 中），
默认不联网同步、不需要账号，API 密钥只保存在本机设置里。

## 能做什么

- **对话内核**：流式输出、工具调用循环、续写（"至少写 N 字"，写不完自动接着写）、
  上下文预算与压缩摘要；
- **消息树**：编辑即成新分支、重新生成成变体，任意时刻可切回旧分支；
- **角色预设**：人设/示例对话/变量/头像，导入导出成 JSON，可拖动排序；
- **搜索**：会话标题与**会话正文**（含用户的话、模型正文、思考过程、工具结果），
  逐处命中跳转 + 高亮当前那一处；
- **工作区**：把本地目录授权给某个会话后，AI 可以读文件、列目录、写文件（写要单独授权）；
- **外观**：6 套内置主题 + 逐色覆盖、字号/密度/气泡样式、动效开关；
- **备份**：全部数据导出为 JSON，导入时追加而不覆盖。

完整行为以 `docs/` 为准（那里写的是**当前代码的实际行为**）。

## 快速开始

需要 **Node 23.6 以上**：`check:sql` 会用 `node:sqlite` 真跑一遍迁移、并用类型擦除直接读 `.ts`，
版本不够时那道门禁会**按设计直接变红**，而不是给一个虚假的绿灯（本机开发用的是 Node 24）。

```bash
npm install
npm run dev      # http://localhost:5173 —— 端口被占会直接失败，不会偷偷换端口
npm run verify   # 提交前必跑：类型 + 分层 + 样式 + 死代码 + SQL + 文档引用 + 测试
npm run build    # = verify + vite build
```

> 浏览器按「协议 + 主机 + 端口」隔离存储。换个端口就是另一个站点、另一套数据 ——
> 所以 `vite.config.ts` 写了 `strictPort: true`，端口冲突时**直接报错**，
> 而不是悄悄换到 5174 让你打开一个空数据库、还以为数据丢了。

## 桌面版（Windows exe）

应用本体是纯前端的（数据在浏览器 OPFS 里的 SQLite），桌面版只加了一层 Electron 壳：
`electron/main.cjs` 用一个**固定端口**的本地静态服务把 `dist/` 端出来，窗口再加载它 ——
不走 `file://`，因为 OPFS 与 wa-sqlite 的 wasm 在那个源下都不成立（表现为静默降级到内存库）。

固定端口是刻意的：**OPFS 按"源"隔离，端口一变就会看到另一个空数据库**，
而用户对这个现象的理解是"我的数据丢了"。同理，壳里刻意没有 preload、没有 IPC，
渲染进程拿不到任何 Node 能力。

```bash
npm run build          # 先产出 dist/
npm run desktop        # 跑本地 dist
npm run desktop:smoke  # 自检：加载 → 探首屏与 OPFS → 验主题目录 → 打印结果 → 退出（0/1）
npm run dist:win       # 出安装包：release/Braid-<版本>-setup.exe（有向导，可改安装目录）
```

自检查的是四件**会让人亏数据或白干**的事：首屏有没有真的渲染出内容、OPFS 有没有可用、
是不是安全上下文、**主题目录里新放的文件有没有被列出来**；它对**打包后的产物**同样有效
（拿到 exe 里解出来的程序加 `--smoke`）。

### 可拔插的主题

exe 同级有一个 `themes/` 目录（首次运行会写入 6 个示例主题与一份格式说明）：

- 放一个 `.json` 进去、**重启应用** → 设置里就能选到它，不必改代码、也不必重新打包；
- 删掉文件 → 它就真的没了。**有运行时目录时只听目录里的**，不会退回打包进应用的示例 ——
  否则"我删了它怎么还在"又会变成没有答案的困惑；
- 普通浏览器里没有这个目录，用打包进应用的那批，行为与以前一致。

刻意没做的两件事：exe 用 Electron 默认图标；没有代码签名 —— 首次运行 Windows 会弹
SmartScreen，选"仍要运行"即可。

## 目录结构

| 目录 | 内容 |
|---|---|
| `src/domain` | 纯业务规则：实体、消息树、配置合并、写作引擎、宏替换（零外部依赖） |
| `src/ports` | 端口（接口）：服务 API、仓储、宿主能力（存储/文件对话框/SQL） |
| `src/application` | 用例编排：ChatService、搜索、压缩、工作区工具、备份、余额 |
| `src/adapters` | 端口实现：SQLite/OPFS、OpenAI 兼容提供方、主题、余额脚本、宿主能力 |
| `src/ui` | React 界面：组件、覆盖层面板、基础件、store、hooks |
| `src/bootstrap` | 组合根：装配端口与适配器 |
| `tests/` | 按层分目录；需要 DOM 的用例在文件顶部切 jsdom |

## 文档

| 文档 | 什么时候看 |
|---|---|
| [docs/README.md](./docs/README.md) | 索引与门禁现状 |
| [01-architecture.md](./docs/01-architecture.md) | 分层、依赖方向、启动顺序 |
| [02-domain.md](./docs/02-domain.md) | 消息树与"编辑即分支"、配置三层合并、上下文预算 |
| [03-storage.md](./docs/03-storage.md) | 表结构、迁移、Worker/OPFS、备份 |
| [04-search.md](./docs/04-search.md) | 搜索范围、命中粒度、高亮 |
| [05-theme.md](./docs/05-theme.md) | token 分层、z-index 刻度、主题 JSON |
| [06-workspace.md](./docs/06-workspace.md) | 文件工具、权限模型、路径沙箱 |
| [07-development.md](./docs/07-development.md) | 门禁、测试布局、已知的坑 |
| [08-ui.md](./docs/08-ui.md) | 界面目录分工、层叠与 portal 规矩、拖拽 |
| [09-balance.md](./docs/09-balance.md) | 余额查询脚本协议 |

## 技术栈

TypeScript · React 19 · Zustand · Vite · Vitest · wa-sqlite（SQLite/WASM + OPFS Worker）·
react-markdown + rehype-highlight；桌面版：Electron + electron-builder（portable 单文件 exe）。

## 状态

个人项目，功能取向是"够用且可解释"：没有内置任何厂商的模型名与价格表（端点、模型名、
余额接口都由用户自己填），也没有云同步 —— 数据只在这台机器上（浏览器 OPFS 里的 SQLite）。
