# 存储

数据全在浏览器本地：SQLite（编译成 WASM）跑在 **Worker** 里，落盘用 **OPFS**。
没有服务端。

## 数据在哪

```
UI 线程 ── postMessage({id, kind}) ──► sqliteWorker.ts
                                          └─ wa-sqlite
                                               └─ VFS: OPFS AccessHandlePoolVFS
                                                       （失败时降级 MemoryAsyncVFS）
```

- `adapters/host/waSqlitePort.ts` —— 主线程侧的 `SqlPort`，自增 id 匹配请求与响应，懒初始化；
- `adapters/host/sqliteWorker.ts` —— Worker 内真正建库、跑迁移；
- `adapters/host/readyGatedSqlPort.ts` —— **就绪门控装饰器**：每次查询先 `await` 迁移完成。
  仓储拿到的是门控版本，迁移本身用未门控端口（否则自己等自己 = 死锁）。

降级到内存 VFS 时 `SqlPort.durable === false`，界面据此提示"数据不会被保存"。

## 表结构

六张表：`schema_migration`（版本登记）、`conversation`、`message`、`role_preset`、`setting`、`repo_meta`。

| 表 | 关键内容 |
|---|---|
| `conversation` | `active_root_child_id`（虚拟根分支指针）、`role_instance_json`（角色快照）、`workspace_root`（**句柄令牌**，不是路径）、`allow_workspace_edit`（三态：1/0/NULL=继承）、`keep_recent_messages`、覆盖类字段（`model_profile_id`/`model`/`params_json`/`system_prompt`/`writing_mode`…）、`forked_from_json`、时间戳、`sort_order`（手动拖动排序后的位置；未手动排过时为 NULL，此时按 `updated_at` 排） |
| `message` | `parent_id` / `variant_of` / `variant_index` / `active_child_id`（树的四根指针）、`segments_json`（正文与工具往来都在这一个字段里）、`status` / `usage_json` / `finish_reason` / `context_flags_json`、`deleted_at`（软删除） |
| `role_preset` | 角色模板（`avatar_json` / `variables_json` / `builtin` / `sort_order` …） |
| `setting` | `key` / `value_json`（全局设置整份存一行） |
| `repo_meta` | 仓库自身的元信息（`scope` / `key` / `value`） |

## 索引

| 索引 | 服务的查询 |
|---|---|
| `idx_conversation_updated(deleted_at, updated_at DESC)` | 会话列表（按最近使用排序） |
| `idx_message_conv(conversation_id, deleted_at)` | 按会话 + 软删除过滤 |
| `idx_message_conv_created(conversation_id, created_at)` | 按会话取消息并**按时间排序**（进会话那条查询） |
| `idx_message_parent(conversation_id, parent_id)` | 树的父子关系 |
| `idx_message_variant(conversation_id, variant_of, variant_index)` | 变体组内定位 |

## 迁移

`adapters/storage/sqlite/migrations.ts` 里是一个按 `version` 升序的数组，`runMigrations.ts` 负责执行与登记。

| ver | name | 内容 |
|---|---|---|
| 1 | `initial_schema` | 四张表 + 全部索引 |
| 2 | `repo_meta` | 建 `repo_meta` |
| 3 | `model_profiles` | `conversation` / `role_preset` 加 `model_profile_id` |
| 4 | `drop_message_cost` | 删 `message.cost_json`（单轮花费功能整体移除） |
| 5 | `conversation_workspace_edit` | `conversation` 加 `allow_workspace_edit` |
| 6 | `message_conversation_created_index` | 加 `idx_message_conv_created` |
| 7 | `context_compression` | 删会话级 `max_context_tokens`、加 `keep_recent_messages` |
| 8 | `manual_sort_order` | `conversation` / `role_preset` 加 `sort_order`（手动拖动排序的位置） |
| 9 | `drop_unread_progress_columns` | 删 `message.continuation_index` / `message.reached_target` / `conversation.sync_state` —— 三列一直**只写不读**（信息可由段落数与正文长度推出） |
| 10 | `drop_workspace_edit_switch` | 删 `conversation.allow_workspace_edit` —— 「允许编辑工作区文件」这个开关整个取消了：**选中工作区就等于给了该目录的读写权**（见 [06-workspace.md](./06-workspace.md)） |

**改 schema 的规矩**：

1. **只追加**，不改已发布的迁移（历史用户的数据要靠它一步步走上来）；
2. 新迁移 + 同步维护 `rows.ts` / `messageRows.ts` / `conversationRows.ts` 里的**列清单常量**；
3. 跑 `npm run check:sql` —— 它会用内存 SQLite 实跑全部迁移，再把列清单与
   `PRAGMA table_info` **双向对照**，还校验 upsert 的占位符数量。
   所以"加了列忘了改清单"这类错误在本地就会被拦住。

## 文件句柄：与数据分离

工作区目录的访问权不是"路径字符串"，而是 File System Access API 的 **FileSystemDirectoryHandle**：

- 句柄存在 **IndexedDB** 里（`adapters/host/handleStore.ts`，"令牌 → 句柄"）；
- SQLite 里只存 `conversation.workspace_root` 这个**令牌**；
- 于是"把数据库拷到另一台机器"不会顺带泄露目录访问权，重启后也能凭令牌取回句柄
  （浏览器可能要求重新确认授权，见 [06-workspace.md](./06-workspace.md)）。

## 备份

`domain/rules/backupDocument.ts` + `application/backup/BackupService.ts`：

- 文档形如 `{ kind: 'braid-backup', version: 1, conversations, messages, roles }`；
- **不含设置**（设置里可能含明文 API Key，不该跟着备份到处走）；
- 导入时**全部重新发号**（`remapBackup` 重映射会话/消息/角色的 id 及所有引用），
  因此导入永远是**追加**，不会覆盖库里已有的任何东西；
- 导出 JSON 带缩进 —— 备份文件是**人也会打开看**的，压成一行就没有这种可能了。

## 仓储

四个 SQLite 仓储（`ConversationStore` / `MessageStore` / `RoleStore` / `SettingStore`）都在
`adapters/storage/sqlite/` 下，各自配套一个 `*Rows.ts` 负责"行 ↔ 实体"的容错转换
（坏数据一律回落默认值，绝不让它冒到界面）。

### 读回时的容错：**连形状一起校验**

库里那一格不一定是这份代码写的：可能是旧版本留下的、被手工改过、或某次中断只写了一半。
所以映射层的原则是"**读取时永远不假设数据完好**"，具体到四类：

| 情况 | 做法 |
|---|---|
| JSON 解析不出来 | 回落 fallback |
| **JSON 解析得出来，但形状不对**（对象字段里塞了 `42` / `"x"` / `[]`） | 也当坏数据，回落 fallback —— 用 `parseJsonObject` |
| 数组字段里混了不合规的项（`["写作", 7]`） | 逐项过滤掉，保持能用的部分 —— 用 `parseJsonArray` |
| 枚举值是认不出的字符串（`writing_mode: "epic"`） | 按**清单**校验后回落（`toRole` / `toStatus` / `toWritingMode`） |

**为什么"形状"这一层必须单独防**：`parseJson` 只保证"解析得出来"。
曾经 `roleFromRow` 直接写 `parseJson<string[]>(row['tags_json'], []).filter(...)` ——
库里那格是 `42` 时，整个装载会在 `filter is not a function` 上抛掉：
**一条坏数据让应用打不开**。同理，`roleInstance` 读成数组之后，
界面会在 `roleInstance.avatar.color` 上抛错。

（曾经还有一条针对三态字段 `allow_workspace_edit` 的规则：认不出的值退回 `null`（= 继承），
**不猜一个布尔**。该字段随迁移 v10 删列一起消失，`toBoolOrNull` 也一并删掉了 ——
不是那条规则错了，而是它守护的语义已经不存在。）

这一整层由 `tests/adapters/storageTolerance.test.ts` 钉住（逐类覆盖上表）。

`MessageStore` 上有一条与搜索相关的设计：见 [04-search.md](./04-search.md)。

**写入的一个细节**：`segments_json` 由 `messageRows.serializeSegments` 序列化，
它按**段对象**做缓存 —— 流式期间每 1.5s 整行 upsert 一次，而其中未变的长段
（工具结果上限 2 万字）本不该被反复 `JSON.stringify`。
手工拼接的结果与 `JSON.stringify` **逐字节相同**，这一点有单测锁住
（这个字段是正文的唯一存放处，拼错一个字符就是静默的数据损坏）。

## 多标签页

数据落在 OPFS 上的一个 SQLite 库里，而**同一个 origin 打开两个标签页就是两份连接写同一个库**。
SQLite 自身的文件锁在 OPFS 上能否正确生效，既不是我们实现的、也没有测试覆盖 ——
换句话说："同时写会不会坏"在应用这一层是**未知**的。

所以：用 Web Locks 选举一个"写者"（`ports/host/InstanceLock.ts` +
`adapters/host/webLockInstanceLock.ts`），第二个标签页拿到 `secondary` 身份，
界面据此**如实提醒**（见 `ui/components/Notices`）。

刻意**只告知、不拦截**：把第二实例挡在门外是一次确定的体验退化，而"并发写一定损坏"
并没有证据 —— 用更糟的确定性去防一个不确定，不划算。身份已经暴露出来了，
真要改成"第二实例只读"，只需换掉 `InstanceLock` 的实现策略。

宿主不支持 Web Locks（旧浏览器 / 测试环境）时返回 `unsupported`：不会有提醒，
也不影响任何功能。
