# 领域模型

`src/domain/` 是纯规则：不碰浏览器 API、不发请求、不落盘 —— 所以能直接单测。
下面每条规则都有一个纯函数实现，界面与编排都只是它的调用方。

## 实体

| 实体 | 文件 | 要点 |
|---|---|---|
| `Conversation` | `entities/conversation.ts` | 会话；持有 `activeRootChildId`（虚拟根的当前分支）、`roleInstance` 快照、各类覆盖字段（`null` = 继承） |
| `MessageNode` | `entities/message.ts` | 消息节点；`segments` 是**分段数组**而不是一坨文本 |
| `RolePreset` | `entities/rolePreset.ts` | 角色"预制体"（可编辑、可导入导出、有内置样例） |
| `RoleInstance` | `entities/roleInstance.ts` | 开新会话时由预制体 `instantiateRole()` 生成，之后**只读** |

### `MessageNode` 的关键字段

- `parentId` —— 树结构；
- `variantOf` / `variantIndex` —— **同一条逻辑消息的多个版本**（组长满足 `variantOf === id`）；
- `activeChildId` —— 当前选中哪个孩子，它就是"激活路径"的指针；
- `segments: MessageSegment[]` —— `text` / `reasoning` / `tool_call` / `tool_result` / `summary` / `image`；
  用分段数组是为了让思考过程、工具往来能被独立渲染与折叠，同时避免给节点加一堆可选字段；
- `status`、`usage`、`finishReason`、`contextFlags`、`deletedAt`（**软删除**，不是物理删除）。

### 激活路径只有一套机制

每条边由父节点的 `activeChildId` 决定选中哪个孩子；首条消息没有父节点，
所以虚拟根的指针挂在 `Conversation.activeRootChildId` 上。

```
activePathOf(index, activeRootChildId)      // 需要整棵树（含正文）
activePathIdsOf(links, activeRootChildId)   // 只需要三列指针（跨会话搜索用）
```

两份实现是**故意的**：一份用于渲染，一份用于"只想知道分支在哪"的轻量场景。
它们的行为有一条**对照测试**盯着（`tests/domain/messageTree.test.ts`），
同一份数据必须给出同一条路径 —— 两份实现就有漂移风险，靠测试而不是靠自觉。

两份实现都做了防御：环形引用（数据损坏）或指针指向不存在的节点时立即停下，界面不会白屏。

## 编辑即分支

**没有任何操作会覆盖已有正文。** 三条路径：

| 用户动作 | 结果 |
|---|---|
| 编辑消息 → 「保存」 | `withNodeTextPatched`：原地改文字，不产生新版本 |
| 编辑用户提问 → 「发送」 | `withNodeAdded`：新提问作为原提问的**兄弟**进入同一变体组，原内容一字不动，旧回答留在旧分支里 |
| 「重新生成」 | 同变体组内 `withNodeAdded` 新版本 |

变体之间用 `shiftVariant(state, id, delta)` 切换（`withActiveChild` 移动指针）。

**这条不变量的代价**：旧分支会一直留在库里。任何"遍历历史文字"的功能都必须显式处理它
（搜索就是这么踩过坑的，见 [04-search.md](./04-search.md)）。

## 配置三层合并

`rules/resolveConfig.ts`：优先级 **会话覆盖 > 角色实例 > 全局默认**。

- 后层只覆盖它**显式写过**的字段；`null` / 空表示"继承"，不是"清空"；
- 数值参数走 `mergeParams(全局, 实例, 会话)` 逐字段合并；
- 上限类 `maxContextTokens` **只有全局一层**（会话级已在迁移 v7 移除）；
- 产出 `sources`（`global | role | conversation`）供界面标注"这个值来自哪一层"，
  `LAYER_LABEL` 提供中文标签。

## 上下文预算与压缩

三件事，分别在不同文件：

| 环节 | 位置 | 做什么 |
|---|---|---|
| **预算** | `resolveConfig.ts` | `contextBudget = maxContextTokens − 单轮输出上限`（= `sampling.maxTokens`，普通对话与续写共享同一份） |
| **发送前体积处理** | `rules/contextPlan.ts: planContext` | 装得下就不动 → `trim-tool-results`（工具结果压成头 400 / 尾 200 字符）→ 仍超则标 `over-budget` **如实上报** |
| **压缩（摘要）** | `rules/contextCompression.ts` | `planCompression` 选段：按轮切分、保留最近 `keepRecentTurns`、目标约 `0.15×`、clamp 到 [300, 4000]、低于 800 token 不压 |

**压缩的关键性质**：原文一字不删，只是不再随请求发送。摘要是 `ContextSummary` 记录，
存在 `conversation.extensions.contextSummaries`（**没有独立的表**），条目上限 `MAX_SUMMARIES`。

调用模型做摘要在应用层：`ChatService.compressNow`；系统提示词与消息装配是
`COMPRESSION_SYSTEM_PROMPT` / `buildCompressionMessages`（可单测）。
用量估算 `estimateContextUsage` 只算**激活路径**、去掉已被摘要覆盖的节点、加上系统提示词。

## 手动排序

侧栏会话、侧栏角色、角色面板列表都能拖动调序。规则集中在 `rules/manualOrder.ts`：

- **顺序存在行上**：`conversation.sort_order` / `role_preset.sort_order`（迁移 v8）。
  顺序是"这一行的属性"，所以导入导出、备份都会带上它，
  也不会出现"数据在表里、顺序在别处"的两份真相；
- **`null` = 没被手动排过**：此时按各自默认规则（会话按最近使用、角色按更新时间）；
- **手动序优先**：拖过之后新消息**不会**再把它顶到最上面 ——
  这类功能最常见的挫败就是"我刚排好，发一条消息它又跳回去了"；
- **只给传进来的 id 重编号**：被搜索过滤掉、没显示的那些保持不动。
  给看不见的东西重编号，等于用户每次拖动都在悄悄改动他没看到的东西。

拖动交互在 `ui/hooks/useDragReorder.ts`（id 式，键盘 `Alt + ↑/↓` 可用）。
算法（`moveIdTo` / `moveIdBy`）是纯函数并单独测过 —— 真正会错的是
"挪完之后顺序对不对"，而不是 DOM 事件。

## 角色：预制体 / 实例

- 预制体（`RolePreset`）是用户可编辑的模板，支持复制、导入导出、内置样例；
- 开新会话时 `instantiateRole(role, now)` 生成快照存进 `conversation.roleInstance`；
- **改预制体不影响已有会话** —— 想同步要用户显式点「重新同步」（`ChatService.resyncRole`）。

这是"预制体 / 实例"而不是引用：历史会话的行为必须可复现，哪怕模板后来被改过。

## 用量与 token 估算

`value-objects/usage.ts`：

- `estimateTokens` —— 按字符类别估算（CJK 与拉丁字符的换算比不同，见 `CHAR_TO_TOKEN_RATIO` / `isCjk`）。
  **系数是拿官方 tokenizer 量出来的**，不是凭经验拍的：汉字 0.7 / 拉丁 0.25（`tokenizer.json`
  实测：汉字散句 0.73 token/字、常见词 0.42、中文标点 0.73、英文散文 0.21、代码 0.30、数字 0.54）。
  早先用的 1.7 来自"1 字约 1.5~1.7 token"这个**旧一代 tokenizer** 的说法，实测
  **平均高估 89%**（中文小说 +145%）。它一个系数喂着三处 —— 上下文预算、压缩触发线、
  界面上的"约 N token"—— 所以那三处一起偏大 2.4 倍（表现为"动不动就压缩、白丢历史"）。
  固定这批实测值的用例：`tests/domain/tokenEstimateCalibration.test.ts`。
  **这是一份"按语言统计"的估算，不是某个模型的词表**：各家 tokenizer 不同，
  要精确只能拿那个模型自己的 `tokenizer.json`（好在我们只在服务商还没回报用量时用它）；
- `estimateTokens` 之外还有一笔**不在提示词里、但每次都要发**的东西：请求的 `tools` 字段
  （工具声明的 JSON：名字 / 描述 / 参数 schema）。工作区里工具信息发**两份** ——
  系统提示词里那段文字说明（`promptSection()`，一直有算）与这份 schema。按 OpenAI 兼容协议
  后者同样计入 `prompt_tokens`，**实测 3 个工具 ≈ 353 token**，而这里早先整份漏算。
  长对话里它只差零点几个百分点，短对话上却能偏低七成 —— 而且方向是危险的那侧
  （以为还有余量 → 请求直接撞上游上限）。现在由 `ContextUsageInput.toolSpecTokens`
  相加，值由 `ChatService.toolSpecTokens()` 提供（按 JSON 内容记忆，顶栏每次刷都要现算）。
  **同一处口径也用于请求组装**（`toolSpecTokensOf`）：`planContext` 的裁剪目标要先扣掉它，
  否则"裁一下就能发"的情形会被闸门误拦；
  用例：`tests/domain/contextCompression.test.ts`（公式）、
  `tests/application/contextBudgetRefresh.test.ts`（接线：有声明与没声明两个服务相减）；
- `estimateCacheStats(previousPrompt, currentPrompt)` —— 提示词缓存的**最长公共前缀**模型，
  产出 `hitTokens` / `missTokens`；
- `cacheStatsOf` / `cacheHitRate` / `formatCacheHitRate` —— 区分"服务端上报"与"本地估算"，
  界面据此显示 `78%` 还是 `≈78%`（这是两件不同的事，混淆过一次）；
- `estimateUsage(promptTokens, completionText)` —— **流式期间的估算用量**：协议上准确的 usage
  随最后一个 chunk 才发回，所以一轮结束前界面上一个数都没有（长回答要几分钟，看起来像"没有统计"）。
  它产出的用量带 `estimated: true`，界面显示成 `≈12.3K tokens`，每轮结束时被准确值替换；
- `addUsage` —— 累加。**只要有一段是估算的，结果就是估算的**（`estimated` 与 `cacheSource` 同一套纪律：
  估算不能冒充服务端数据）。

> 界面上的口径：`≈` 只意味着"服务商还没告诉我们"，它同时是"这一轮还在写"的信号。

## 设置的 schema 版本与归一化

全局设置**整份**存在 `setting` 表的一行里（`value_json`），所以"数据比代码旧"是常态：
用户可能几个月没清过浏览器存储，也可能从旧备份导入过一份设置。

- `CURRENT_SETTINGS_SCHEMA_VERSION` 是当前版本，每份设置都带 `schemaVersion`；
- 读入时统一归一化，而且**按 id 归并，不是直接采用**：
  - `normalizeMetaFields`（消息信息栏的字段列表）：旧数据缺字段 → 补默认值；
    数据里留着已删除的 id → 丢掉（否则界面会渲染出空白项）；
  - `normalizeProfiles`（模型配置列表）：同一套纪律；
  - 合并补丁时也走这两个函数 —— 各算各的早晚会出现"校验用的列表与实际存的列表不一致"；
- `activeProfileId` 指向的配置可能已被删除，合并时**回落到第一条**，保证"总有可用的配置"；
- 用户手改过的 JSON（或旧备份）进来时，以 `DEFAULT_APP_SETTINGS` 的键为白名单转换，
  名单外的键不会进入设置对象。

一句话：**设置是"读的时候归一化"，而不是"写的时候保证"** —— 因为写入方可能是旧版本、
旧备份或用户手改的文件。

## 会话导出

"导出这条会话"的**筛选规则**在 `domain/rules/conversationMarkdown.ts`：只导出**当前激活的那条线**
（编辑与"重新生成"会在库里留下旧分支，一起导出来读者会看到前后矛盾的对话），并跳过软删除的消息。
渲染成 Markdown 也在那里 —— 它是纯函数，所以能直接跑用例。

需要连分支一起带走时应该用整库备份（见 [03-storage.md](./03-storage.md)），那是另一件事。

## 领域层的其它规则

| 模块 | 一句话 |
|---|---|
| `rules/macroResolver.ts` | 提示词里的宏替换（未识别的宏原样保留，便于排查） |
| `rules/toolTranscript.ts` | 分段 → 协议消息序列（把工具往还原成 `assistant(tool_calls)` + `tool(...)`，顺序错了请求会被拒） |
| `rules/fuzzyMatch.ts` | 会话标题的近似匹配（子串 + 顺序子序列） |
| `rules/workspacePath.ts` | 相对路径沙箱（见 [06-workspace.md](./06-workspace.md)） |
| `rules/backupDocument.ts` | 备份文档的解析与 id 重映射 |
| `rules/themeInheritance.ts` | 主题深合并与坏文件容错 |
| `value-objects/workspace.ts` | 工作区权限的三态解析 |
| `value-objects/writingMode.ts` | 写作档位（`softMaxOf` / `estimatedRounds`） |
