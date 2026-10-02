# 开发约定

## 动手前后

```bash
npm run dev      # 5173，端口被占会直接失败（strictPort）
npm run verify   # 提交前必跑
npm run build    # verify + 构建
```

## 门禁的**真实**行为（别以为它拦住了一切）

| 门禁 | 拦得住 | 说明 |
|---|---|---|
| `check:layers` | 跨层 import（ui → adapters 等） | —— |
| `check:styles` | `styles.x` 无定义；裸数字 z-index / 未知 `--z-*` token；**定义了却没人用的 CSS 类** | 确实要留（为将来准备的公共类）就在那条规则那一行写 `/* @dead-style-ok: 理由 */` |
| `check:dead` | 在本文件之外没有任何引用的导出 | 确实要留（扩展点）就在声明行写 `// @dead-export-ok: 理由` |
| `check:sql` | 迁移跑不通、列清单与表结构不一致、upsert 占位符数不对 | 环境跑不了（Node < 22.5 无 `node:sqlite`，或 < 23.6 无类型擦除）时**直接失败**；知情时用 `BRAID_ALLOW_SKIP_SQL=1` 显式跳过 |
| `check:docrefs` | 文档里引用到的代码文件不存在（改了文件名却忘了改 `docs/*.md`） | 引用一个**不存在的文件**时，只要在同一段里写明它不存在就不算 —— 那是"反面例子"，不是失效引用 |
| `test` | 断言失败 | —— |

**六类**都真阻断。可能"故意留着"的东西（死样式、尚未接线的导出）一律走**显式豁免**
（`@dead-style-ok` / `@dead-export-ok`），把"为什么留着"写在原地；
连"跳过 SQL 检查"都要**显式写一个环境变量**，而不是默认拿到一个虚假的绿灯。

死样式早先是"只提示不阻断"，改成阻断是因为**提示等于没有门禁**：它每一轮拆分/改名都会被
重算一遍，本项目已经踩过（拆分设置面板时，一个 CSS Module 被多文件共享，死样式被重复报出
几十条，那之后"提示"就再没人看了）。豁免通道保证"确实要留"仍有余地。

## 测试

- 运行器 `vitest`，默认环境是 `node`；需要 DOM 的用例在文件顶部写
  `// @vitest-environment jsdom` 单独切过去（`tests/ui/` 下的 jsdom 用例就是这么做的）。
  **但仍不要测布局**：jsdom 没有排版，`getBoundingClientRect` 恒返回 0，那种测试只会"通过" ——
  组件可以测渲染与交互，几何相关的逻辑要抽成纯函数再测；
- jsdom 的两个具体坑（都踩过，`tests/ui/dragReorderEvents.test.tsx` 里有现成写法）：
  1. 它**没有实现 `DragEvent`**，`fireEvent.drop(el, { clientY })` 会退回 `Event`，
     而 `Event` 的构造函数不认 `clientY` —— 事件上根本没这个属性。要自己造
     `new MouseEvent('drop', { clientY, bubbles: true })` 再用 `fireEvent(el, event)`；
  2. 没有排版，所以每条用例要自己"摆"几何：给元素塞一个
     `getBoundingClientRect`（返回 `{top, bottom, ...}`）当作假布局，
     这样"指针落在哪一行"才有意义；判断规则本身仍要抽成纯函数单独测；
- 测试放**根目录 `tests/`**（不是 `src/` 旁边）——因为 `check:layers` 只扫 `src/`；
  文件数、用例数**不要抄进文档**（每次提交都在变），要看就看 `npm test` 的输出；
- 目录按层分：`tests/domain/`（纯逻辑）、`tests/application/`（含用
  `chatHarness` 端到端跑 `ChatService`，以及 `streamBehavior` / `roundRequest` / `continuation`
  这类"把一条规则钉住"的用例）、`tests/adapters/`（mock fetch 测 SSE 与工具协议、
  **错误映射**（401/402/429/504/网络失败/中止/校验）、以及 `storageTolerance.test.ts`
  的读回容错）、`tests/ui/`（jsdom 下渲染面板与拖拽事件）；
- 别名在 `vitest.config.ts` 里是**手工写的**，必须与 `tsconfig.json` / `vite.config.ts` 三处保持一致；
- 夹具在 `tests/helpers/`：`messageNode.ts`（造节点/树）、`chatHarness.ts`（假仓储 + 假 provider，
  能真跑一轮对话）。

**写测试的收益是实打实的**：这一轮里，写测过程中发现了三个真缺陷 ——
`withActiveChild` 允许把指针写到不存在的节点、软删除回退会选中"本来就不可见"的兄弟、
缓存估算的断言暴露了两半各自 `ceil` 的问题。凡是被测试钉住的规则，之后都不会再飘。

## 性能：已实测过的热点（**不要重复优化**）

这些结论是量出来的，不是猜的 —— 免得每次有人"顺手优化"一遍又把它改回去。
（Node 环境实测，算法与应用里一致；2000 条消息、每轮 60 次取平均）

| 函数 | 500 条 | 2000 条 | 结论 |
|---|---|---|---|
| `buildTreeIndex` | 0.11 ms | 0.19 ms | 每帧重建**不需要缓存** |
| `activePathOf` | 0.03 ms | 0.12 ms | 同上 |
| `variantPosition`（全量） | 0.18 ms | 0.30 ms | O(兄弟数)，非线性 |

合计约 0.6 ms/帧，流式渲染 8 帧/秒 ≈ **0.5% 单核**。

**为什么不能按"节点 id 集合"缓存索引**：索引里含 `activeChildId`（当前选中的分支），
切换变体时 id 集合完全不变而索引必须重算 —— 那种缓存是**不健全**的，
会比它省下的那点时间造成更难查的问题。

已经做完的真实优化（别误删）：

- `adapters/storage/sqlite/messageRows.ts: serializeSegments` —— `segments_json` 按**段对象**
  缓存序列化结果（未变的两万字工具结果不再每 1.5s 重算一次），
  与 `JSON.stringify` 的逐字节一致性由 `tests/adapters/messageRows.test.ts` 锁住。

## 已被门禁锁住的约定

1. **不要写裸数字 z-index**：用 `--z-*`（刻度见 [05-theme.md](./05-theme.md)）。这是踩过坑的：
   一个 `z-index: 6` 让消息区按钮盖住了设置面板；
2. **颜色一律用 `--color-*`**（`--p-*` 是原始色阶，组件不许引用）；
3. **相对路径**去碰文件，绝对路径会被沙箱拒绝；
4. **改 schema 只追加迁移**，并同步维护列清单常量（否则 `check:sql` 会失败）。

## 待处理清单（按优先级）

做一轮"用户用起来会不会踩坑"的盘点后的结果，**已修的写在这里是为了别再改回去**，
未修的都留下触发点，下次直接接上。（`✅` = 已有用例或门禁兜住）

**P0 · 会丢内容 / 静默失败**

| # | 事项 | 状态 |
|---|---|---|
| 1 | 删除消息 | ✅ **语义已改成"只删这一条"**（用户反复要求的）：`withNodeRemoved` 把被删节点的孩子**接到它前面那条上**（在链上跳过一环），后面的对话原样留着；父节点的选中指针改指接过来的第一个孩子，当前这条线不会断。**不要改回级联** —— 原先的 `withSoftDelete`（连同整棵子树）保留在领域层，带 `@dead-export-ok`，留给将来"删除后续"的入口。按钮文案就是"删除此条消息"（一律如实），也不必再确认（用户明确不要）。用例：`tests/domain/messageTreeEdits.test.ts`（6 例）、`tests/application/messageDeletion.test.ts`（3 例） |
| 2 | 角色面板改了没保存就切走 → 草稿被静默重置 | ✅ 提示条三选一（保存并切换 / 放弃并切换 / 留下）。**关闭路径按产品决定不做提示**：直接关面板（Esc / 点遮罩）就是丢弃草稿 —— 用户明确说"不需要草稿"，所以这里**不是漏做**，别再加确认框 |
| 3 | 发送被闸门拒绝（上下文超预算等）时草稿已被清空 → 字既没进会话也没了 | ✅ `chatStore.send` 返回成败，输入区只在被接受时清空（用例：`tests/ui/chatStoreSend.test.ts`） |
| 4 | `persistMessage` / `finalizeStream` 丢掉落库结果 → 屏幕正常但内容没存下来，重开才丢 | ✅ 快照 `persistenceError` + 通知条，写入恢复即消失（用例：`tests/application/persistenceNotice.test.ts`） |
| 5 | 起始装载失败只写在「设置 → 关于」里 → 空白界面看着像"本来就没数据" | ✅ 通知条也显示存储错误（`Notices` + `storageStore.status.error`） |

**P1 · 容易把配置配坏 / 操作没反馈**

| # | 事项 | 状态 |
|---|---|---|
| 6 | `NumberField` 清空输入框 = `Number('')` = 0，且不校验上下限 → 上下文长度之类被写成 0 | ✅ 草稿 + 失焦钳制（`clampNumber`，用例 `tests/ui/controls.test.ts`） |
| 7 | 设置保存失败的红字**永久**挂在设置页（成功也不清） | ✅ 成功即清（`settingsStore`） |
| 8 | 长耗时操作没有进行中/完成反馈：导出全部数据、从备份导入（导入后还整页重载） | ✅ 两个入口都禁用 + 文案换"正在…"；导出前先让出一帧（同步重活否则刷不出忙碌态）；导入汇总**跨重载**交接（`ui/utils/importSummary` + `main.tsx`），不再被 `reload` 冲掉 |
| 9 | 复制到剪贴板成败都没有反馈（而且"已复制"在失败时也会显示 —— 会骗人） | ✅ 统一走 `ui/utils/clipboard: copyText`，成功才显示"已复制"，失败推通知（用例 `tests/ui/clipboard.test.ts`） |
| 10 | 主题偏好写入失败被 `catch {}` 吞掉 → 换了主题下次打开又回默认 | ✅ `writeThemePreference` 返回成败，`uiStore` 据此说一句（"这次没能记住…"） |
| 15 | 提示出现**两个浮层**：`IconButton` 自带原生 `title`，调用方又套了 `<Tooltip>`；没被套住的（收起侧栏、导出全部、会话设置…）则只有那个慢半拍、不跟主题的原生浮层 | ✅ `IconButton` 一律不写 `title`：外面有 `Tooltip` 就不再叠，没有就自己补一个（`useInsideTooltip` 上下文）；消息区两个跳转按钮与侧栏"上一处/下一处命中"也接上了（用例 `tests/ui/tooltipSingle.test.tsx`） |
| 11 | 头像图片解码失败时界面毫无反应；**且取消选图后按钮永久卡在"处理中…"并禁用** | ✅ `pickAvatarImage` 区分"取消/失败"（`cancel` 事件 + 焦点兜底），失败推通知；取消即刻复位（用例见 `tests/ui/`） |
| 14 | 会话区没有空状态文案（角色区有）→ 列表空着没有任何"下一步" | ✅ 与角色区同语气的一句提示（搜索无结果时另说一句） |

**P2 · 误操作防护**

| # | 事项 | 状态 |
|---|---|---|
| 12 | 一击即覆盖且无确认：恢复默认设置、清空/插入余额脚本、删除模型配置、「全部恢复为继承」 | ✅ 四处都改成**通知 + 撤销**（`Notice.action`，由 `Notices` 渲染）。选它而不是确认框：正常操作一次点击就过，只有真做错了才需要那一下（用例 `tests/ui/noticeAction.test.tsx`） |
| 13 | 文本输入无长度上限（超长标题会撑坏侧栏与顶栏）；会话标题可被清成空串 | ✅ 三个"一行里显示"的名字都有上限了：会话标题 120、角色名 60、模型名/配置名 160（常量都在领域层，输入处裁剪）。**预设词不设硬上限**（悄悄截断用户写的指令比让它长着更糟），改成给**体积提示**：会话设置里的系统提示词那一行会显示"约 N tok · 每轮都会随请求发出" |

**P3 · 历史遗留（不是功能缺陷，但会误导后来者）**

- `ChatService` 的拆分**正在进行**，按"先补测试、再搬一块"的节奏：
  - ✅ 上下文 → `application/chat/contextManager.ts`（窄接口注入）；
  - ✅ 续写判定 → `application/chat/continuation.ts`（`decideContinuation`：字数下限/软上限/
    结束原因/停顿/轮数上限，有用例钉住；**判定顺序有讲究**，见文件头注释）；
  - ✅ **请求组装** → `application/chat/roundRequest.ts`（`buildRoundRequest`：工具往来先并进
    消息、续写指令在预算前入列、没工具就不发 `tools` 字段、没裁剪时 `contextNote` 必须是 `null`；
    有用例钉住。顺带纠正了一处误解：`planContext` **不丢历史**，只压过长的工具输出）；
  - ✅ 行为测试就位：`tests/application/streamBehavior.test.ts`（分片拼接与思考分段、上游报错、
    provider 抛异常、用户中止＝`aborted` 而非 `error`、工具轮上下文、半截内容也落库）；
  - ✅ **工具轮** → `application/chat/toolRound.ts`（`runToolRound`：**先固化再执行**（写文件不可
    撤销，必须先让用户看到模型要动它）、**撞上限整轮不动**、**中止后剩下的调用不执行**、
    每个结果立刻上屏并落库；有用例钉住，含"工具执行期间按停止"的端到端用例）；
    同轮修掉两个小问题：停止后**不再多发一次请求**（探针验过：改回 `continue` 会让请求数从 1 变 2）、
    定稿时**不留空文本段**（否则"停在工具调用上"的回复会多一个空的彩色气泡）；
  - ✅ **收尾的纯判定** → `application/chat/streamOutcome.ts`（`classifyStreamOutcome`：
    **用户停止不是错误**（中止时带着 ABORTED 也不按失败处理）、"只出了思考没有正文"要补一句可操作
    说明、以及"判断有没有正文要连 `settled` 一起看"）。服务里只留"写进树 + 落库 + 通知"；
  - 至此 `ChatService` 的拆分告一段落：拆出 `contextManager` / `roundRequest` / `toolRound` /
    `continuation` / `streamOutcome` 五个模块（各自的规则都在自己文件头写清了）——
    剩下的主体是"轮次循环 + 流消费 + 落库时机"，那是一个**连贯的状态机**，
    再切只会把时序拆散，不建议继续拆；
- ~~`message` 表 `reached_target` 列的 `DEFAULT 1` 与实体语义相反~~ → **已随删列一并了结**：
  该列不存在了，默认值的问题自然消失（见下一条）；
- ~~`MessageNode.reached_target` / `continuationIndex`、`conversation.sync_state` 是只写不读的预留字段~~
  → **已删（迁移 v9）**。删之前逐处核过：生产代码里**没有任何读取方**，只有测试拿它们当编排的
  可观测点。删除的代价被两点抵掉：
  1. 它们记录的信息**都能推出来**（续了几轮 = 这条消息里有几段正文；有没有写到下限 = 正文长度与
     档位下限的对比），所以"看库诊断"并没有真的少掉什么；
  2. 留着不读的字段会让人以为它们参与判断 —— 这条危害比省几个字节大得多。
  测试里的可观测点换成了**用户看得见的东西**（段落数、"有没有上限提示"），见
  `tests/application/continuationEngine.test.ts`；
- 在**搜索过滤态**下拖动排序时，被拖的子集可能与未参与排序的项同号 —— 顺序仍然确定
  （同号由"最近使用"兜底），只是那两项的先后不严格按拖的来（见 `manualOrder.ts: renumberByOrder`）；
- ~~`uiStore.settingsSection`（跨面板跳转）目前没有调用方，机制留着~~ → **已删**：没有调用方的机制只会带来"传进来一个本面板不渲染的 id 就白屏"的风险；真要跳转时再加一个**带类型**的入口；
- 死样式门禁**是阻断的**，出口是显式声明（`/* @dead-style-ok: 理由 */`）：它确实可能是
  "为将来留的公共类"，但那种意图必须写进样式里 —— 不能靠"反正只提示"糊过去。

**注释 / 引用类的几条已统一修正**（记在这里免得又跑偏）：`check-layers.mjs` 顶部那份"规则清单"
与代码里的 `ALLOWED` 逐字一致；`toolTranscript.ts` 改指真实存在的测试文件；`BraidProvider.tsx`
不再提仓库里没有的 ESLint；`ports/Theme.ts` 的 token 层数改成真实的两层。

**"不存在的文档 / 凭空的不变量编号"第二轮清理**：早先还有一批注释指向
`docs/02-architecture.md`、`docs/05-theme-spec.md`、`docs/06-context-strategy.md` 这些**仓库里
根本没有的文件**，以及 `OLG-5` / `INV-2` / `INV-4` 这类编号 —— docs 里从未定义过它们。
读代码的人会照着去找那个"§3.3 的有意偏离"，全部落空。现在：能指到真实文档的就指
（`docs/01-architecture.md`、`docs/05-theme.md`），指不到的把规则**直接写清楚**，不指。
**加注释时别写"见某文档 §x"，除非那个锚点真的存在。**

**读回容错补了一轮专项**（写用例时照出来的，都是"库里那一格形状不对"引发）：`tags_json` 是标量时
整个装载会抛掉（`filter is not a function`）、`role_instance_json` 是数组时界面会在
`avatar.color` 上抛错、`writing_mode: "epic"` 这类认不出的枚举会原样进领域层、`params_json`/
`variables_json` 是标量时字段会变成数字。现在统一走 `parseJsonObject` / `parseJsonArray`
并按清单校验枚举，用例钉住（`tests/adapters/storageTolerance.test.ts`），
规则写在 [03-storage.md](./03-storage.md)。

**工作区的三层权限开关已经整个删掉**（迁移 v10 一并删列）：**选中工作区 = 给了该目录的读写权**。
一个动作能说清的事不要拆成全局默认 + 会话覆盖 + 浏览器授权 —— 三层里任何一层没对上，
用户看到的都是"我明明选了目录还是写不了"，而界面上看不出是哪一层。
桌面版的 FSA 授权也已经做成跨重启有效（`electron/main.cjs` 的权限处理）。
详见 [06-workspace.md](./06-workspace.md)。

**「一次最多写多少」只剩一个字段**：`sampling.maxTokens`（界面叫「单轮输出上限」，
放在 设置 → 上下文，因为预算 = 上下文长度 − 它）。两处并存的代价是真实的：
档位里曾有一个 `maxTokensPerRequest`，与采样里的 `max_tokens` 各配一份，
用户还得猜哪个在生效（真实反馈）。现在普通对话与短/中/长三个档位共享它。
**改它必须让顶栏进度条立刻更新** —— 快照只在发送/切换会话/压缩时才提交，
所以 `ChatService` 订阅了设置变化，并且只对"影响预算的两个字段"重算
（温度那个滑块一拖几十次，不能每次都拿整个对话重算一遍用量）。
用例：`tests/application/contextBudgetRefresh.test.ts`。

## 打包 exe：两个环境坑（都踩过）

`npm run dist:win` 在本机第一次跑会撞到下面两条，都不是配置问题：

- **`EPERM: rename 'win-unpacked.tmp' -> 'win-unpacked'`** —— 出在"输出目录在工作区内"：
  有东西**正在监视工作区的新文件**（IDE 的文件索引 / 杀软扫描刚解压出的 Electron）持有句柄，
  重命名就被拒。解法是把输出挪到工作区外，再把 exe 拷回来：
  ```bash
  npx electron-builder --win nsis --config.directories.output="$TEMP/braid-pack"
  # 然后把 $TEMP/braid-pack/Braid-<版本>-setup.exe 拷进 release/
  ```

  **连不上 GitHub 时**（打包要下载 NSIS / 签名资源，报 `connect ETIMEDOUT ...:443`）：
  换个镜像即可，不必改配置 ——

  ```bash
  # PowerShell
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  # cmd
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  ```

  另一个坑：打包中途被打断会**占着输出目录**（`EBUSY`）。不要去杀进程
  （残留的 node/electron 很可能混着编辑器自己的），换个干净输出目录重跑就行。
- **`trash-failed` / "Some operations were aborted"** —— 本机的 `fs.rm` 被一个"安全删除"垫片
  接管了（通过 `NODE_OPTIONS=--require ...node-language-shim.cjs` 注入），它会拦下打包工具
  清理自己临时目录的动作。给那条命令用干净环境即可：`$env:NODE_OPTIONS=""`（只影响该子进程）。

**打包完成后一定要对产物本身跑一次自检**（`Braid.exe --smoke`）：跑的是打包后的真实程序，
能证明"asar 里的资源加载得到、OPFS 可用、首屏真的渲染出来了"这三件事 ——
只看到 exe 文件生成，证明不了它能用。

另外两条：

- **只出安装版**：`npm run dist:win` 出 `Braid-<版本>-setup.exe`（NSIS：有向导、可改安装目录、
  带开始菜单与卸载项）。**不做便携版** —— 多一份上百 MB 的产物，还多一条"数据目录在哪"的
  分支要维护，用不上就不留。
  `nsis.deleteAppDataOnUninstall` **必须是 false** —— 应用数据在 `%APPDATA%\Braid`
  （OPFS 上的 SQLite，用户的全部会话），卸载时删掉它是最不可挽回的一类事故；
- 从 GitHub 取打包组件偶尔会 `ETIMEDOUT`（瞬时）：**重试即可**。若卡在证书探测上，
  加 `CSC_IDENTITY_AUTO_DISCOVERY=false` 明确告诉它没有证书。

## 可拔插的主题目录

主题文件既可以打进应用（浏览器里跑时用），也可以放在 **exe 同级的 `themes/`** 里运行时读取：

- 主进程把那个目录端在 `/_external-themes`（渲染进程没有 Node 权限，只能这样给它）：
  `index.json` 给清单、`/<名字>.json` 给单个文件，名字必须过 `^[\w.-]+\.json$` 白名单
  （这是唯一能读到磁盘任意位置的口子）；
- 目录位置：安装版取 `exe 所在目录`；便携版取 `PORTABLE_EXECUTABLE_DIR`
  （便携 exe 会把自己解到临时目录，`getPath('exe')` 指的是那份临时副本，
  往那儿写东西用户一关就没了）；开发态直接用仓库里的 `themes/`；
- 首次运行会把打包的示例主题与一份 `README.md` 写进去，**之后不再覆盖** ——
  它是用户的目录，删掉的示例不该每次启动又被塞回来；
- **有运行时目录时只听目录里的**（`loadRuntimeThemes` 返回 `null` = 没有目录 → 用打包的；
  `[]` = 目录是空的 → 一个外置主题都没有）。合并两种来源会让"删了却还在"变成无解的问题；
- 它在挂载 React **之前**加载（`main.tsx`）：主题注册表不通知订阅者，
  挂载后再注册用户得刷新才看得到。失败与超时都按"没有目录"处理，不拖首屏。

## 本轮收口的几件事（别改回去）

- **密钥擦除有测试兜底**：`toPersistableSettings` 的净化由 `tests/domain/settingsSecrets.test.ts`
  逐字节扫描 —— 将来新增一个装密钥的字段而忘了净化，用例会红；
- **UPSERT 算法只有一份**：`adapters/storage/sqlite/upsert.ts`，`check-sql.mjs` 直接加载它；
- **续写的轮间要按同一套规矩处理上下文，再发这一轮**（`ChatService.runStream` 里那段）：
  1. 到压缩触发线且 `compression: 'auto'` → **压一次再接着写**。压的只是更早的对话历史：
     `planCompression` 硬性保留最近一轮，**正在写的这条消息压不到**（工具轮的调用与结果也在同一轮里），
     所以"一个气泡连续写"的体验不受影响。压缩后**必须**重算纪要/历史/提示词，
     否则压掉的内容照样发出去，等于白压；
  2. 压不动（没开自动压缩、或没有可压的历史）且已超预算 → 停在上一轮，并把下一步说清楚
     （与发送前那道闸门**说同一套话**：压缩一次 / 调大「上下文长度」，然后说「继续」）；
  **第 1 步刻意不排除"已经超预算"**（与 `shouldAutoCompress` 的唯一差别）：那道谓词是给**发送前**
  用的（用户就在键盘前，拦住他更好），而轮间是生成正在进行中，没有"让用户点一下"的间隙 ——
  要么压完接着写，要么干净停下。删掉第 1 步，超预算的请求会一个个打出去
  （探针验过：删掉后有 22 次请求全打出去），赌输了上游拒绝的文案会被 `appendFailure` 追进正文，
  用户在自己写的小说里读到一段报错；
- **生成中默认不给压，但轮间可以**：`compress()` 的守卫仍然拒绝界面按钮在生成中调用；
  只有轮次循环会传 `allowWhileStreaming`。破例成立靠两个前提同时满足 ——
  此刻**没有正在传输的请求**（上一轮的流已读完）、且**正在写的那条消息压不到**。
  另外压缩只作用在**激活会话**上，所以服务里加了一道 `this.activeId === conversationId`
  （用户可能已经切走）。
  早先脚本里抄了一份"保持同一算法"的副本，而那种约定没有东西守护：改了实现忘了副本，
  门禁会拿着旧算法给出**假绿灯**；
- **树索引按引用缓存**：`domain/rules/messageTree.ts: cachedTreeIndex`。消息树是不可变的，
  所以同一棵树重复查只建一次索引 —— 顶栏用量在流式期约 8 次/秒重算，这不是微优化；
- **`ChatService` 的拆分已经告一段落**（不要再往里塞新职责）：上下文 → `contextManager.ts`、
  请求组装 → `roundRequest.ts`、工具轮 → `toolRound.ts`、续写判定 → `continuation.ts`、
  收尾判定 → `streamOutcome.ts`，各带独立用例；服务里剩下的主体是
  **"轮次循环 + 流消费 + 落库时机"** —— 那是一个连贯的状态机，再切只会把时序拆散；
- **输出上限的天花板是 100 万 token**（`MAX_OUTPUT_TOKENS_CEILING`）：65,536 是好几年前的口径，
  现在的模型动辄几十万输出（deepseek-flash 给到 384,000），卡在那里用户**连填都填不进去**。
  与之配套的一条纪律：**Braid 不替用户猜模型能力**（上一条也适用于上下文长度）——
  界面照实说"按你所用模型的上限填，填超了上游会报错"，而不是假装算过一个 `min(...)`
  （早先界面上就写着"会被模型真实能力自动裁剪"，而代码里根本没有这段裁剪）；
- **「每轮询问」是真的会停**（`ChatService.runStream` 里 `askEachRound` 那个分支）：
  判定说"还能再写一轮"时不再自己往下写，而是把决定权交回用户，界面上长出「继续写」。
  这个档位曾经是**空转的**——实现只区分"是不是 off"，于是它与「自动续写」跑的是同一段逻辑
  （用户反馈："每轮询问没有效果"）。两条约束别动：
  1. **不新建消息**：`continueWriting` 复用同一条节点，把已有段当作"已定稿的轮次"交回去
     （拼出来的请求与上一轮逐字节一致，前缀缓存照旧命中），否则"一个气泡连续写"的观感就断了；
  2. **邀请存内存、不落库**（`continuableMessageId`）：它表达的是"现在轮到你决定了"，
     不是"这条消息曾经怎样"—— 后者要加一列数据与一次迁移，而对解释历史毫无用处。
     代价如实写在类型注释里：重启应用后按钮不会回来（想接着写，打个「继续」同样做得到）。
  `tests/application/continuationEngine.test.ts` 里 6 例钉住（含"关闭档位不挂邀请"）；

## 加东西时的落点

| 加什么 | 动哪几处 |
|---|---|
| 一个设置项 | `domain/value-objects/appSettings.ts`（字段 + 默认值）→ `ui/panels/settings/XSection.tsx`（控件；面板已按分区拆分，外壳只做分发与导航） |
| 一个文件工具 | `application/tools/workspaceToolRegistry.ts` 的 `DEFINITIONS`（参数 schema + execute + 系统提示词里的说明） |
| 一个面板 | `ui/panels/X.tsx` + `X.module.css`，在 `App.tsx` 里 `lazy()` 挂上，`uiStore` 加一个 `PanelId` |
| 一张表 | 追加迁移 + 维护列清单 + 新端口方法 + 仓储实现 + 单测（纯逻辑请抽到 `domain/rules`） |
| 一种主题 | `themes/*.json`（必须写 `extends`） |
