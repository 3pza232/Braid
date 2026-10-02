# Braid 文档

本地优先的 AI 对话工作台：数据存在你浏览器的 OPFS 里（SQLite），默认不联网同步，
不需要账号。

> 本目录只描述**当前代码的实际行为**。不含变更日志 —— 想知道"以前怎样"请查 git 历史，
> 想知道"现在怎样"看这里。

## 阅读顺序

| 文档 | 什么时候看 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 第一次读代码：分层、依赖方向、端口与适配器的对应关系、启动顺序 |
| [02-domain.md](./02-domain.md) | 搞清业务规则：消息树与"编辑即分支"、配置三层合并、上下文预算与压缩、角色实例化 |
| [03-storage.md](./03-storage.md) | 碰数据：表结构与索引、迁移、Worker/OPFS、文件句柄、备份 |
| [04-search.md](./04-search.md) | 改搜索：范围、命中粒度、"下一处"的语义 |
| [05-theme.md](./05-theme.md) | 改样式：token 分层、z-index 刻度、主题 JSON、CSS Module 纪律 |
| [06-workspace.md](./06-workspace.md) | 改文件工具：权限模型、路径沙箱、工具协议 |
| [07-development.md](./07-development.md) | 提交前：门禁、测试布局、已知的坑与不一致 |
| [08-ui.md](./08-ui.md) | 改界面：目录分工、层叠与 portal 的规矩、拖拽与搜索高亮的实现 |
| [09-balance.md](./09-balance.md) | 改余额脚本：脚本协议、占位符、失败语义 |

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173 —— 端口被占用会直接失败，不会偷偷换端口
npm run verify   # 提交前必跑
npm run build    # = verify + vite build（构建前先过门禁）
```

**关于 5173**：浏览器按「协议 + 主机 + 端口」隔离存储，换个端口就是另一个站点、另一套数据。
`vite.config.ts` 因此写了 `strictPort: true` —— 端口冲突时**直接报错**，而不是悄悄换到 5174
让你打开一个空数据库、还以为数据丢了。

## 技术栈

TypeScript 7 · React 19 · Zustand 5 · Vite 8 · Vitest 5 · wa-sqlite（SQLite 编译为 WASM，
跑在 Worker 里，数据落在 OPFS）· react-markdown + rehype-highlight。

## 门禁现状（**注意，只有死样式是"提示"**）

`npm run verify` = `typecheck → check:layers → check:styles → check:dead → check:sql → test`

| 门禁 | 拦得住 |
|---|---|
| `typecheck` | 类型错误 |
| `check:layers` | 跨层引用（ui 直接 import adapters 之类） |
| `check:styles` | `styles.x` 无定义、**裸数字 z-index 或未知 `--z-*` token**、以及**定义了没人用的死样式** |
| `check:dead` | 在本文件之外没有任何引用的导出（要留就在声明行写 `// @dead-export-ok: 理由`） |
| `check:sql` | 迁移实跑 + 列清单与表结构对照；环境跑不了时**直接失败**，知情才可 `BRAID_ALLOW_SKIP_SQL=1` 跳过 |
| `check:docrefs` | 文档里引用到的代码文件不存在（改了文件名却忘了改 `docs/*.md`）—— 引用一个**不存在的文件**时，只要在同一段里写明它不存在，就不算 |
| `test` | 全部用例（文件数、用例数以 `npm test` 的输出为准，别把数字抄进文档） |

死样式也是**阻断**的。它确实可能是"故意留给将来"的公共类，所以给了一条显式出口：
在规则那一行写 `/* @dead-style-ok: 理由 */` —— 让"为什么留着"留在样式里，而不是靠记忆。
详见 [07-development.md](./07-development.md)。
