# 架构

## 分层与依赖方向

代码按"外层可依赖内层、内层绝不知道外层"组织，规则由 `scripts/check-layers.mjs` 强制：

```
domain          ← 纯业务规则与数据结构，不 import 任何其它层
  ↑
ports           ← 接口契约（含 AppContainer），可以描述 domain 的类型
  ↑
application     ← 业务编排（服务），实现 ports 里的 API，只依赖 domain/ports
  ↑
adapters        ← 外部世界的落地实现（SQLite、Provider、文件系统……）
  ↑
bootstrap       ← 组合根：唯一知道"用哪个实现装配哪个端口"的地方
ui              ← 组件与状态镜像；**禁止** import adapters / bootstrap
```

| 层 | 允许依赖 | 备注 |
|---|---|---|
| `domain` | shared, domain | 必须保持纯函数、可单测 |
| `ports` | shared, domain, ports | |
| `application` | shared, domain, ports, application | |
| `adapters` | shared, domain, ports, **application**, adapters | 允许 application 是为了复用工具执行器一类的编排 |
| `ui` | shared, domain, ports, application, ui | **禁 adapters / bootstrap**，否则界面会绕过端口直接碰存储 |
| `bootstrap` | 全部 | 组合根特权 |
| `src/` 根（`main.tsx` / `App.tsx`） | 全部 | |

`shared/` 放两端都要用的东西（品牌类型 `MessageId`/`ConversationId`、`Result` 与 `AppError`）。

**不要靠注释来记住这条**：约束只有一个执行者（`check-layers.mjs`）。仓库里没有 ESLint，
任何"ESLint 会拦住你"的注释都是错的。

## 端口与实现

| 端口 | 实现 | 说明 |
|---|---|---|
| `ChatApi` | `application/chat/ChatService.ts` | 会话 + 消息树 + 流式/续写/工具循环/压缩/搜索 |
| `RoleApi` | `application/role/RoleService.ts` | 角色 CRUD、导入导出、样例播种 |
| `SettingsApi` | `application/settings/SettingsService.ts` | 全局设置读写与落盘（写盘前擦密钥） |
| `BalanceApi` | `application/balance/BalanceService.ts` | 用户脚本 → provider 执行 → 缓存广播 |
| `WorkspaceApi` | `application/workspace/WorkspaceService.ts` | 目录选择/授权/读写 + 编辑门禁 |
| `BackupApi` | `application/backup/BackupService.ts` | 全量导出/导入（直连仓储） |
| `LLMProvider` | `adapters/providers/openAICompatProvider.ts` | OpenAI 兼容协议（流式 SSE） |
| `BalanceProvider` | `adapters/balance/scriptBalanceProvider.ts` | 执行用户提供的小段 JS |
| `ThemeRegistry` | `adapters/themes/*` | 主题注册 / 编译 / 继承 |
| `repositories/*` | `adapters/storage/sqlite/*` | Conversation / Message / Role / Setting 四个仓储 |
| `host/SqlPort` | `adapters/host/waSqlitePort.ts` + `sqliteWorker.ts` | SQL 跑在 Worker；`readyGatedSqlPort.ts` 是就绪门控装饰器 |
| `host/FileSystemPort` | `adapters/host/fsaFileSystemPort.ts` + `handleStore.ts` | File System Access API；句柄存在 IndexedDB |
| `host/FileDialogPort` | `adapters/host/fsaFileDialog.ts` | 打开/保存对话框 |

`AppContainer` 的接口定义放在 `ports/`（而不是 `bootstrap/`）就是为了让 UI 能引用容器契约
却不依赖组合根。

## 启动顺序

`src/main.tsx` → `bootstrap/createContainer.ts`：

1. **`createContainer()` 是纯同步的** —— 建主题注册表、装配服务、打开 Worker 端口（但懒初始化）、
   把 `storageReady` 这个 Promise 起跑，然后立刻返回；
2. `createRoot().render(<BraidProvider><App /></BraidProvider>)` —— **马上挂载首屏**，
   不等数据库；
3. 后台继续：WASM 加载 + 建表迁移（在 Worker 内）→ 各服务 `load()` →
   `balance.refresh()`、用量重算。

所以**首屏不阻塞**。仓储拿到的是 `readyGatedSqlPort`（每次查询先等迁移完成），
因此"界面已经能点、表还没建好"这个窗口期不会导致查询失败。
迁移本身用**未门控**的端口，避免死锁。

## 构建

`vite.config.ts`：`target: es2022`、`sourcemap: true`、`server.strictPort: true`；
别名 `@`(src) / `@shared` / `@domain` / `@ports` / `@app` / `@adapters` / `@ui` / `@bootstrap`
—— **必须与 `tsconfig.json` 的 `paths`、`vitest.config.ts` 的手工别名保持一致**（三处）。

`index.html` 里有一段内联脚本：读 `localStorage['braid.theme']` + `matchMedia`，
在首帧前设好 `data-theme` / `color-scheme`，用来防主题闪烁（FOUC）。

## 代码导航（按"我要改什么"）

| 想做的事 | 从哪开始 |
|---|---|
| 改流式输出行为 | `application/chat/ChatService.ts`（节流常量在文件顶部） |
| 改发给模型的消息形态 | `application/chat/messageAssembly.ts`（纯函数，有测试盯着**逐字节稳定性**） |
| 改消息树的规则 | `domain/rules/messageTree.ts`（查询）、`messageTreeEdits.ts`（变更） |
| 加一个文件工具 | `application/tools/workspaceToolRegistry.ts` 的 `DEFINITIONS` |
| 加一个设置项 | `domain/value-objects/appSettings.ts` + `ui/panels/settings/XSection.tsx`（面板按分区一文件一节，外壳只做分发，不写死分区顺序） |
| 改样式/加颜色 | `ui/styles/global.css` 或组件旁的 `*.module.css`，颜色一律用 `--color-*` |
| 加主题 | 根目录 `themes/*.json`（必须写 `extends`） |
