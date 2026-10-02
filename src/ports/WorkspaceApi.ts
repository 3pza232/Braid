import type { ErrorCode, Result } from '@shared/result';
import type { FsEntry, HandleState, WorkspaceRef } from './host/FileSystemPort';

/**
 * 工作区的对外契约
 *
 * 【为什么"选目录"也放在这个契约里，而不是让界面直接改会话字段】
 * 选目录不是一个字段赋值，它是一串副作用：弹系统选择器 → 把句柄存进 IndexedDB
 * → 把令牌写进会话 → 重新探测句柄状态 → 刷新目录列表。
 * 让界面自己按顺序调这些步骤，就等于把业务规则抄进了组件里（本项目明令禁止）。
 * 所以对外只暴露"选一个目录"这一个动作，其余都在应用层完成。
 */

/**
 * 发给**用户**的警报
 *
 * 与"发给模型的错误"是同一件事的两个面：
 *  - 用户看到一条通知（本对象）；
 *  - 模型收到一条失败的 `tool_result`（由 `writeFile` 返回的 `Result` 承载）。
 * 两边都必须有 —— 只告诉模型，用户会奇怪"AI 怎么突然说没权限"；
 * 只告诉用户，模型会以为自己写成功了，接着胡编后续内容。
 */
export interface WorkspaceAlert {
  id: string;
  at: number;
  code: ErrorCode;
  message: string;
}

export interface WorkspaceSnapshot {
  loaded: boolean;
  /** 当前会话选中的目录；null = 未选择 */
  root: WorkspaceRef | null;
  /** 读取权限状态（浏览器重启后可能需要重新授权） */
  handleState: HandleState;
  /**
   * **写入**权限状态（浏览器的授权，不是我们的开关）
   *
   * 与 `handleState` 分开：拿到"可读"不代表"可写"。
   * 混成一个状态就会出"界面显示已开启、实际写不了"这种最难查的问题。
   */
  writeState: HandleState;
  /** 能不能读：选中 + 已授权。读**不需要**额外开关 */
  canRead: boolean;
  /** 能不能写：选中 + 浏览器已授予写入。**没有"我们的开关"这一层**（见 06-workspace.md） */
  canWrite: boolean;
  supported: boolean;
  unsupportedReason: string | null;
  /** 当前列出的目录项（未选目录时为空） */
  entries: FsEntry[];
  error: string | null;
}

export interface WorkspaceApi {
  snapshot(): WorkspaceSnapshot;
  isLoaded(): boolean;
  load(): Promise<Result<WorkspaceSnapshot>>;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;

  /**
   * 弹目录选择器并把结果写进当前会话
   *
   * 返回 `null` = 用户取消（不是错误）。返回引用 = 已就绪，界面可直接展示。
   */
  selectDirectory(): Promise<Result<WorkspaceRef | null>>;
  /** 清空当前会话的工作区（同时丢弃句柄，避免 IndexedDB 里越积越多） */
  clearDirectory(): Promise<Result<void>>;

  /**
   * 清理孤儿句柄：删掉不在 `keep` 里的句柄记录，返回删掉的条数
   *
   * 由组合根在装载完成后调用一次，`keep` = 所有会话仍在引用的令牌集合。
   */
  pruneHandles(keep: readonly string[]): Promise<Result<number>>;
  /** 重新申请**读取**授权（必须由用户点击触发，浏览器要求） */
  reauthorize(): Promise<Result<HandleState>>;
  /**
   * 申请**写入**授权
   *
   * ⚠️ 必须在用户点击的处理函数里**同步**调用（先于任何 `await`），
   * 因为浏览器只认用户手势。所以界面上的用法是：
   * 打开编辑开关 → 先 `await authorizeWrite()` → 授权成功才真的打开开关。
   * 反过来（先开开关、事后补申请）拿不到手势，必然失败。
   */
  authorizeWrite(): Promise<Result<HandleState>>;

  refresh(dir?: string): Promise<Result<FsEntry[]>>;
  /**
   * 列目录，但**不改变界面正在展示的那一份**
   *
   * 与 `refresh` 的区别只在此处：AI 在工具里翻看某个子目录时，
   * 不该把用户面板里的目录列表顶掉 —— 那是两件不同的事，
   * 一件是"模型在探查"，一件是"用户在浏览"。
   */
  listFiles(dir?: string): Promise<Result<FsEntry[]>>;
  readFile(path: string): Promise<Result<string>>;
  /**
   * 写入文件
   *
   * **编辑权限的唯一门禁就在这里**：未开启时不会落盘、不会调用底层写接口，
   * 而是发出警报并返回 `FS_EDIT_DENIED`。
   * 做成"唯一入口"是刻意的 —— 将来无论加多少文件工具，都必须经过它，
   * 不可能出现"某个工具忘了检查开关"这种事。
   */
  writeFile(path: string, content: string): Promise<Result<void>>;

  subscribeAlerts(listener: (alert: WorkspaceAlert) => void): () => void;
}
