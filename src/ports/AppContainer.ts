import type { BalanceApi } from './BalanceApi';
import type { ChatApi } from './ChatApi';
import type { SqlPort, StorageStatus } from './host/SqlPort';
import type { LLMProvider } from './LLMProvider';
import type { RoleApi } from './RoleApi';
import type { BackupApi } from './BackupApi';
import type { FileDialogPort } from './host/FileDialogPort';
import type { InstanceLock } from './host/InstanceLock';
import type { SettingsApi } from './SettingsApi';
import type { ThemeRegistry } from './Theme';
import type { WorkspaceApi } from './WorkspaceApi';

/**
 * 应用容器契约
 *
 * 为什么把"容器的形状"放在 ports 层而不是 bootstrap 层？
 * 因为表现层需要它的类型来接收注入，但**不允许**依赖组合根
 * （否则 UI 就知道"具体用了哪个实现"，依赖倒置被破坏）。
 *
 * 所以：容器形状 = 契约（ports），容器装配 = 实现（bootstrap）。
 * 这也让分层检查能自动抓到越层引用。
 */
export interface AppContainer {
  readonly themes: ThemeRegistry;
  readonly settings: SettingsApi;
  readonly roles: RoleApi;
  readonly balance: BalanceApi;
  /** 会话列表与消息树 */
  readonly chat: ChatApi;
  /** 会话级工作区目录：读默认允许，写需显式授权（见 WorkspaceApi） */
  readonly workspace: WorkspaceApi;
  /** 一次性文件对话框（导入/导出 JSON） */
  readonly fileDialog: FileDialogPort;
  /** 全量备份：把库里的一切导出成一个文件，再原样导回来 */
  readonly backup: BackupApi;
  /**
   * 模型提供方
   *
   * 暴露给界面是为了「测试连接」——只有适配器知道"这家怎么写请求"，
   * 而这件事没有业务规则可放，包一层服务反而多一层转发。
   */
  readonly provider: LLMProvider;

  /**
   * 多标签页协调：本页是这份数据的"写者"还是"后开的那个"
   *
   * 暴露出来是为了让界面能把风险**如实**告诉用户（见 ports/host/InstanceLock）。
   */
  readonly instanceLock: InstanceLock;

  /** 本地 SQLite（跑在 Worker 里；查询会自动等待建表迁移完成） */
  readonly sql: SqlPort;
  /** 存储初始化结果（迁移、记录数），启动后写入界面供「关于」展示 */
  readonly storageReady: Promise<StorageStatus>;
}
