import { createScriptBalanceProvider } from '@adapters/balance/scriptBalanceProvider';
import { createFsaFileDialog } from '@adapters/host/fsaFileDialog';
import { createFsaFileSystemPort } from '@adapters/host/fsaFileSystemPort';
import { createReadyGatedSqlPort } from '@adapters/host/readyGatedSqlPort';
import { createWebLockInstanceLock } from '@adapters/host/webLockInstanceLock';
import { createOpenAICompatProvider } from '@adapters/providers/openAICompatProvider';
import { createSqliteConversationStore } from '@adapters/storage/sqlite/sqliteConversationStore';
import { createSqliteMessageStore } from '@adapters/storage/sqlite/sqliteMessageStore';
import { createSqliteRoleStore } from '@adapters/storage/sqlite/sqliteRoleStore';
import { createSqliteSettingStore } from '@adapters/storage/sqlite/sqliteSettingStore';
import { builtinThemes, createThemeRegistry } from '@adapters/themes';
import { loadExternalThemes } from '@adapters/themes/externalThemes';
import { BalanceService } from '@app/balance/BalanceService';
import { ChatService } from '@app/chat/ChatService';
import { RoleService } from '@app/role/RoleService';
import { createBackupService } from '@app/backup/BackupService';
import { SettingsService } from '@app/settings/SettingsService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import { WorkspaceService } from '@app/workspace/WorkspaceService';
import type { AppContainer } from '@ports/AppContainer';
import type { Theme, ThemeRegistry } from '@ports/Theme';
import { createStorage } from './createStorage';

export type { AppContainer };

/**
 * 组合根（Composition Root）
 *
 * 全项目**唯一**知道"具体用哪个实现"的地方（见 [docs/01-architecture.md](../docs/01-architecture.md)）。
 * 上层代码只依赖 @ports 里的接口，因此替换实现不需要改动任何业务代码。
 */
export interface ContainerOptions {
  /** 预留：允许测试替身或未来的主题插件追加主题 */
  extraThemes?: readonly Theme[];
  /**
   * **运行时主题**（桌面版：exe 同级 `themes/` 里读到的那些）
   *
   * 传了就**替代**打包进应用的那批；`undefined` = 没有运行时目录（浏览器），用打包的那批。
   * 这条语义由 `externalThemes.ts` 的文件头解释："删掉文件就该真的没了" ——
   * 所以"有目录但为空"（`[]`）与"没有目录"（`undefined`）必须是两种状态。
   */
  runtimeThemes?: readonly Theme[];
}

export function createContainer(options: ContainerOptions = {}): AppContainer {
  /*
   * 主题注册表
   *
   * 内置主题（白天/黑夜）作为**基础主题**，`themes/*.json` 里的外置主题
   * 通过 extends 继承它们 —— 添加一个主题文件即可上，无需改任何代码。
   */
  const themes: ThemeRegistry = createThemeRegistry([
    ...builtinThemes,
    // 有运行时目录就只听它的（`[]` = 用户把文件都删了，那也是有效状态）
    ...(options.runtimeThemes ?? loadExternalThemes(builtinThemes)),
    ...(options.extraThemes ?? []),
  ]);

  // 存储：打开引擎 → 建表迁移。全部收敛进一个 Promise。
  const storage = createStorage();

  /*
   * 仓储拿到的是**门控端口**：任何查询都会先等迁移完成。
   * 这样界面可以立刻挂载（不被 WASM 加载拖慢），而仓储也不必到处 await ready。
   * 注意迁移用的是未门控的 storage.sql，否则会自我等待死锁。
   */
  const sql = createReadyGatedSqlPort(storage.sql, storage.ready);

  const settings = new SettingsService(createSqliteSettingStore(sql));
  const roles = new RoleService(createSqliteRoleStore(sql));
  const balance = new BalanceService(createScriptBalanceProvider(), settings);


  /*
   * 模型提供方
   *
   * 适配器是**无状态**的：连接信息（地址 / 凭据 / 超时）由 ChatService 在每次请求时
   * 从"解析后的模型配置"里取出来随请求传入。所以一份配置改了立刻生效，
   * 而且同一个实例可以直接拿来做「测试连接」。
   *
   * 目前只有一个 OpenAI 兼容实现，它已经覆盖 DeepSeek / OpenAI / Ollama / 自建网关。
   * 将来接非兼容协议（如 Anthropic 原生）时，这里多一行、上层零改动。
   */
  const provider = createOpenAICompatProvider();

  /*
   * 工作区与会话服务**互相需要对方**：
   *  - 工作区要读"当前会话选了哪个目录、编辑开关怎么样"；
   *  - 会话要拿工具集，而工具必须过工作区的编辑门禁。
   *
   * 打破这个环的办法是**延迟取值**（闭包）而不是把两者合成一个大服务：
   * 工作区拿到的是一组取值函数，真正被调用时会话服务早已构造完毕。
   * 合成一个大服务会把"文件"与"对话"永久焊死，是本项目一直在避免的耦合。
   */
  let chat: ChatService;

  const workspace = new WorkspaceService(createFsaFileSystemPort(), {
    root: () => chat.snapshot().conversation.workspaceRoot,
    setRoot: async (root) => {
      await chat.updateActive({ workspaceRoot: root });
    },
  });

  const tools = createWorkspaceToolRegistry(workspace);

  // 仓储实例提出来共享：备份服务要直接读"库里的一切"，
  // 而 ChatService 手里只有当前会话的视图
  const conversationStore = createSqliteConversationStore(sql);
  const messageStore = createSqliteMessageStore(sql);

  chat = new ChatService(conversationStore, messageStore, settings, provider, tools);

  const backup = createBackupService({
    conversations: conversationStore,
    messages: messageStore,
    roles,
  });

  // 会话切换（或工作区令牌被改）时同步一次。syncScope 内部先比对再动手，
  // 所以挂在会高频 emit 的 chat 上也不会带来额外 I/O。
  chat.subscribe(() => void workspace.syncScope());

  /*
   * 首次装载放在**组合根**，而不是各个 UI store 的 bind() 里。
   *
   * 理由：数据装载是"应用初始化"的一部分，不该由"界面挂载"来触发 ——
   * 否则没有 UI 的场景（测试、将来可能的无头模式）就永远不会加载数据。
   * UI store 只订阅结果，不再负责触发。
   *
   * 顺序：迁移完成 → 三个服务装载（角色服务会写入出厂样例，
   * 会话服务会补一个空会话）→ 重新统计记录数。
   * 最后一步很关键：否则「关于」会显示"角色 0"，明明是好的却像坏的。
   */
  const storageReady = (async () => {
    await storage.ready;
    const results = await Promise.all([settings.load(), roles.load(), chat.load()]);
    // 工作区必须等会话装完才能装载：它要读"当前会话选了哪个目录"
    await workspace.load();

    /*
     * 清理孤儿句柄
     *
     * 删会话不会顺手删它的目录句柄（同一令牌可能还被别处引用），所以这里按
     * "现在还被哪些会话引用"反向扫一遍。放在启动路径上而不是删除路径上：
     * 只有一个执行点，且"没被引用"就是这个记录该被删的定义。
     */
    const referenced = chat
      .snapshot()
      .conversations.map((conversation) => conversation.workspaceRoot)
      .filter((token): token is string => typeof token === 'string' && token.length > 0);
    await workspace.pruneHandles(referenced);

    /*
     * 启动后立刻查一次余额
     *
     * 必须**等设置装完**才能查：余额脚本存在当前模型配置里，
     * 而 UI store 的 bind() 是同步执行的、那时设置还在读库 ——
     * 早了就是"进程序不刷余额"。
     */
    void balance.refresh();

    const refreshed = await storage.recount();

    // 装载失败不要静默：把它写进状态，用户能在「关于」里看到原因，
    // 而不是对着空白界面猜（"服务装载失败"与"本来就没数据"必须可区分）。
    const failure = results.find((result) => !result.ok);
    return failure && !failure.ok
      ? { ...refreshed, error: `数据装载失败：${failure.error.message}` }
      : refreshed;
  })();

  return {
    themes,
    settings,
    roles,
    balance,
    chat,
    workspace,
    fileDialog: createFsaFileDialog(),
    backup,
    provider,
    // 多标签页协调：只判定身份，不做拦截（理由见 ports/host/InstanceLock）
    instanceLock: createWebLockInstanceLock(),
    sql,
    storageReady,
  };
}
