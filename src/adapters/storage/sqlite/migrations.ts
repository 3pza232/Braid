import type { Migration } from '@ports/host/SqlPort';

/**
 * 数据库迁移
 *
 * 规则：
 *  - **只追加，不修改已发布的迁移**；需要改结构就新增一条；
 *  - 每条迁移在一个事务里执行（由 runMigrations 保证）；
 *  - `version` 严格递增，已应用的记录在 `schema_migration` 表里。
 *
 * 表结构与列清单对应 docs/03-storage.md（那份文档是当前事实，这里不再各写一份）：
 *  - conversation 有「角色实例」快照、续写覆盖字段，以及 v8 的 `sort_order`；
 *  - message 的正文与工具往来都在 `segments_json` 里
 *    （单轮花费 `cost_json` 已在 v4 移除，别照着旧印象找它）。
 */

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      // ── 会话 ──
      `CREATE TABLE IF NOT EXISTS conversation (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL DEFAULT '新对话',
        workspace_root       TEXT,

        -- 角色实例快照（创建会话时从角色预设实例化，之后只读）
        role_instance_json   TEXT,
        role_id              TEXT,

        -- 会话级覆盖：NULL / '{}' 表示继承上一层
        model                TEXT,
        params_json          TEXT NOT NULL DEFAULT '{}',
        system_prompt        TEXT,
        writing_mode         TEXT NOT NULL DEFAULT 'chat',
        min_output_chars     INTEGER,
        continuation_prompt  TEXT,
        max_context_tokens   INTEGER,
        assistant_name       TEXT,
        user_name            TEXT,

        -- 消息树的「虚拟根当前选中分支」
        active_root_child_id TEXT,
        forked_from_json     TEXT,

        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        deleted_at           INTEGER,
        sync_state           TEXT NOT NULL DEFAULT 'local',
        extensions_json      TEXT NOT NULL DEFAULT '{}',
        schema_version       INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversation_updated
        ON conversation(deleted_at, updated_at DESC)`,

      // ── 消息（消息树节点） ──
      `CREATE TABLE IF NOT EXISTS message (
        id                   TEXT PRIMARY KEY,
        conversation_id      TEXT NOT NULL,
        parent_id            TEXT,

        -- 变体组：同一逻辑消息的多个版本共享 variant_of
        variant_of           TEXT NOT NULL,
        variant_index        INTEGER NOT NULL DEFAULT 0,
        active_child_id      TEXT,

        role                 TEXT NOT NULL,
        segments_json        TEXT NOT NULL DEFAULT '[]',
        status               TEXT NOT NULL,

        -- 复现所需的生成快照
        model_ref            TEXT,
        params_snapshot_json TEXT,
        role_id_at_creation  TEXT,
        usage_json           TEXT,
        cost_json            TEXT,
        finish_reason        TEXT,

        -- 上下文管理标记
        context_flags_json   TEXT NOT NULL DEFAULT '{}',

        -- 续写模式进度
        continuation_index   INTEGER NOT NULL DEFAULT 0,
        reached_target       INTEGER NOT NULL DEFAULT 1,

        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        deleted_at           INTEGER,
        extensions_json      TEXT NOT NULL DEFAULT '{}',
        schema_version       INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_conv ON message(conversation_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_message_parent ON message(conversation_id, parent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_message_variant
        ON message(conversation_id, variant_of, variant_index)`,

      // ── 角色预设（预制体） ──
      `CREATE TABLE IF NOT EXISTS role_preset (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        avatar_json     TEXT,
        description     TEXT NOT NULL DEFAULT '',
        tags_json       TEXT NOT NULL DEFAULT '[]',
        assistant_name  TEXT,
        user_name       TEXT,
        system_prompt   TEXT NOT NULL DEFAULT '',
        greeting        TEXT NOT NULL DEFAULT '',
        model           TEXT,
        params_json     TEXT NOT NULL DEFAULT '{}',
        writing_mode    TEXT,
        variables_json  TEXT NOT NULL DEFAULT '{}',
        builtin         INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        extensions_json TEXT NOT NULL DEFAULT '{}',
        schema_version  INTEGER NOT NULL DEFAULT 1
      )`,

      // ── 键值设置 ──
      `CREATE TABLE IF NOT EXISTS setting (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },

  {
    version: 2,
    name: 'repo_meta',
    statements: [
      /*
       * 仓储元数据（键值）
       *
       * 为什么需要它：有些"状态"既不属于业务实体，也不该由应用层去猜 ——
       * 例如「出厂样例是否已经写过」（决定用户删光样例后重启要不要重新塞回来）。
       *
       * 放进 setting 表是不对的：那是**用户设置**，导出/重置设置时会一起被清掉。
       * 单独一张 meta 表，语义清晰，且未来 Conversation/Message 仓储也能复用。
       */
      `CREATE TABLE IF NOT EXISTS repo_meta (
        scope TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (scope, key)
      )`,
    ],
  },

  {
    version: 3,
    name: 'model_profiles',
    statements: [
      /*
       * 用哪一份「模型配置」（端点 + 凭据 + 余额）现在是独立字段。
       *
       * 之所以不把原来的 `model`（模型名）列去掉：它仍然有用 ——
       * 同一套端点与凭据，想临时换个模型名跑，不必新建一份配置。
       * 所以两者并存：`model_profile_id` 决定"打到哪、用哪个 Key"，
       * `model` 是可选的模型名覆盖。
       */
      `ALTER TABLE conversation ADD COLUMN model_profile_id TEXT`,
      `ALTER TABLE role_preset ADD COLUMN model_profile_id TEXT`,
    ],
  },

  {
    version: 4,
    name: 'drop_message_cost',
    statements: [
      /*
       * 去掉「本轮消耗金额」
       *
       * 它的实现是"请求前后各读一次余额、相减"，但**服务端计费是异步的**：
       * 刚发完请求时余额往往还没扣，于是差额读出来是 0，
       * 界面上就是"AI 还在输出就显示 0.0000"。靠猜结算时机来"修"这件事
       * 只会越来越不可靠，而这个数字本身对使用体验没什么价值 ——
       * 顶栏的余额显示已经能满足"我还有多少钱"这个真实需求。
       *
       * 因此整块能力移除，连同它的列一起删掉，不留半死状态。
       */
      `ALTER TABLE message DROP COLUMN cost_json`,
    ],
  },

  {
    version: 5,
    name: 'conversation_workspace_edit',
    statements: [
      /*
       * 会话级「允许编辑工作区文件」覆盖
       *
       * **三态**：1 = 允许、0 = 禁止、NULL = 继承全局设置。
       * 必须能表达 NULL，因为"没表态"和"明确关掉"是两件事：
       * 如果这里默认 0，那么用户在全局打开开关后，所有已存在的会话都会
       * 因为自己是 0 而依然不生效 —— 用户会觉得"开关坏了"。
       */
      `ALTER TABLE conversation ADD COLUMN allow_workspace_edit INTEGER`,
    ],
  },

  {
    version: 6,
    name: 'message_conversation_created_index',
    statements: [
      /*
       * 消息按「会话 + 创建时间」取用的覆盖索引
       *
       * 进会话时的那条查询是：
       *   SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC
       * 已有的 idx_message_conv 只覆盖了 WHERE（前缀 conversation_id、其后是 deleted_at），
       * 排序那一列没进索引 —— SQLite 只能把该会话的行取出来再排一次。
       * 长会话（几千条消息）下这一次排序发生在**每次进入会话**时，是能感觉到的卡顿。
       *
       * 新索引把排序一起覆盖掉，排序步骤因此可以整段省掉（索引本身就是有序的）。
       * 旧索引保留：它还服务于"按 deleted_at 过滤"的那类查询，且删除它要多一次表重建。
       */
      `CREATE INDEX IF NOT EXISTS idx_message_conv_created
        ON message(conversation_id, created_at)`,
    ],
  },

  {
    version: 7,
    name: 'context_compression',
    statements: [
      /*
       * 会话级「上下文上限」取消
       *
       * 上限是**这份配置/这台机器**的性质（取决于给模型留了多大的窗口），
       * 单个会话改它没有正当用途，只会造出"这个会话莫名其妙不能聊了"。
       * 真正该按会话调的是"保留多少轮原文"—— 写小说与问代码想留住的历史长度不同。
       */
      `ALTER TABLE conversation DROP COLUMN max_context_tokens`,
      // 三态：NULL = 继承全局（与 allow_workspace_edit 同一套语义）
      `ALTER TABLE conversation ADD COLUMN keep_recent_messages INTEGER`,
    ],
  },

  {
    version: 8,
    name: 'manual_sort_order',
    statements: [
      /*
       * 手动排序位（NULL = 没被手动排过）
       *
       * 顺序是"这一行的属性"，所以它跟着行走。存进设置里会变成
       * "数据在表里、顺序在别处"的两份真相 —— 导入、导出、备份都会漏掉它。
       *
       * 为 NULL 的行按各自的默认规则排在后面（会话按最近使用、角色按更新时间），
       * 排过的按 sort_order 升序排在前面。拖动一次会给**可见的全部**编号，
       * 所以"混着排过的和没排过的"只在第一次拖动之前存在。
       */
      `ALTER TABLE conversation ADD COLUMN sort_order INTEGER`,
      `ALTER TABLE role_preset ADD COLUMN sort_order INTEGER`,
    ],
  },

  {
    version: 9,
    name: 'drop_unread_progress_columns',
    statements: [
      /*
       * 删掉三个**从没被读过**的进度列
       *
       *  - `message.continuation_index` / `message.reached_target`（续写到第几轮 / 有没有写到下限）
       *  - `conversation.sync_state`（同步状态，从没做过同步）
       *
       * 它们一直在被**如实写入**，但没有任何消费方：界面不显示、引擎的下一次决策也不读。
       * 实体注释里早就写着"将来一直没人读就该连同列一起删掉" —— 留着不读的字段，
       * 会让人以为它们参与判断，从而基于错误前提去改代码（这一条比省几个字节重要得多）。
       *
       * 它们记录的信息**没有消失**，只是不再单独存：
       *  - 续了几轮 = 这条消息里有几段正文（每续一轮固化一段）；
       *  - 有没有写到下限 = 正文长度与档位下限的对比。
       * 另外 `reached_target` 原来的 `DEFAULT 1` 与语义相反（"默认已达标"），
       * 虽然因为写入走显式列清单而从未生效，但看默认值会得出错误结论 —— 删掉正好一并了结。
       *
       * 这是**不可逆**的：要恢复只能重新加列（值无法找回，但它们都是派生值，没有"丢失"一说）。
       */
      `ALTER TABLE message DROP COLUMN continuation_index`,
      `ALTER TABLE message DROP COLUMN reached_target`,
      `ALTER TABLE conversation DROP COLUMN sync_state`,
    ],
  },

  {
    version: 10,
    name: 'drop_workspace_edit_switch',
    statements: [
      /*
       * 删掉「允许编辑工作区文件」这个开关
       *
       * 【为什么这个开关该消失】
       * 它把一件用户心里只有一件事的事情拆成了三层：全局默认 + 会话覆盖 + 浏览器授权。
       * 用户的实际感受是"我明明选了目录、也开了开关，它还是说没权限" ——
       * 三层里任何一层没对上，写文件就失败，而界面上看不出是哪一层。
       *
       * 现在的语义是**一个动作就够了**：选中工作区 = 给了该目录的读写权
       *（选目录时浏览器会弹一次授权，那次点击就是用户的同意）。
       * 于是 `WorkspaceService.writeFile` 只剩两道门：目录还在吗、浏览器放行了吗。
       *
       * 旧库里这一列可能是三态（1 / 0 / NULL，NULL = 继承全局）。删掉它**不影响任何数据**：
       * 它只表达"允不允许"，而现在的答案恒为"允许"。
       */
      `ALTER TABLE conversation DROP COLUMN allow_workspace_edit`,
    ],
  },
];
