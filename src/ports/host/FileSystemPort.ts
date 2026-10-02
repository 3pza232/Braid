import type { Result } from '@shared/result';

/**
 * 文件系统端口（宿主能力）
 *
 * 与 `SqlPort` 同一套思路：**业务层只说"我要列目录 / 读文件 / 写文件"，
 * 至于底层是浏览器的 File System Access 还是内存假实现，由适配器决定**。
 * 这条已经被验证过一次：加桌面壳（Electron）、把发布形态从网页换成 exe 时，
 * 领域层与应用层**一行都没改**。
 *
 * 【为什么路径参数是"相对路径"而不是绝对路径】
 * 见 `domain/rules/workspacePath.ts` 的说明：浏览器拿不到绝对路径，
 * 而"只接受相对路径"让越界在结构上不可能发生。适配器负责把相对路径
 * 交给句柄 API 解析。
 */

/**
 * 一个已授权目录的**引用**
 *
 * `id` 是不透明令牌（会存进 `conversation.workspace_root`），
 * `label` 只用于界面展示 —— 因为浏览器里拿不到真实路径，
 * 我们只能显示目录名。这一点必须让用户知道，否则他会以为"没选成功"。
 */
export interface WorkspaceRef {
  id: string;
  label: string;
}

/**
 * 句柄的当前可用状态
 *
 * 这不是"有没有选过"，而是"**现在还能不能用**"：
 * 浏览器出于安全会在重启后把已存句柄降级为需要重新授权，
 * 用户也可能在系统里把目录删了。这几种情况必须能区分，
 * 否则界面只能显示一句无用的"出错了"。
 */
export type HandleState =
  /** 可用 */
  | 'granted'
  /** 需要用一次点击重新授权（浏览器重启后的常态，不是错误） */
  | 'prompt'
  /** 用户明确拒绝了授权 */
  | 'denied'
  /** 目录已经不存在 / 句柄已失效 */
  | 'missing'
  /** 当前宿主不支持目录访问 */
  | 'unsupported';

export interface FsEntry {
  name: string;
  /** 相对于工作区根的路径 */
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

export interface FileSystemPort {
  /** 当前宿主是否具备目录访问能力（Web 端取决于浏览器） */
  readonly supported: boolean;
  /** 不支持时的原因，用于界面说明（例如"请用 Chrome / Edge 打开"） */
  readonly unsupportedReason: string | null;

  /**
   * 弹系统目录选择器
   *
   * `mode` 决定**一次要到位的权限**：
   *  - 已经允许编辑 → 直接要 `readwrite`；
   *  - 否则 → 只要 `read`（默认最小权限）。
   *
   * 为什么必须在**这里**把权限要够：浏览器只在**用户手势**里授予写入权限，
   * 而"选择目录"正是那个手势。事后补申请（比如工具执行到一半）拿不到手势，
   * 只会被拒绝 —— 而且听起来像"功能坏了"，其实只是申请的时机不对。
   *
   * 返回 `null` 表示用户取消 —— 取消不是错误，所以是有值的成功结果，
   * 而不是一个"用户取消了"的错误码。
   */
  pickDirectory(options: { mode: 'read' | 'readwrite' }): Promise<Result<WorkspaceRef | null>>;

  /**
   * 删掉**不再被任何会话引用**的句柄记录，返回删掉的条数
   *
   * 【为什么需要它】删会话不会顺手删句柄（同一个令牌可能还被别处引用，
   * 在删除点判断"还有谁在用"需要一份散落各处的知识）。于是 IndexedDB 里
   * 会慢慢攒下永远用不到的记录。反过来问"现在还在用哪些"只有一个答案来源，
   * 而且"没被引用"正是一条记录该被删的**定义** —— 这样删永远安全。
   *
   * 由组合根在装载完成后调用一次（见 createContainer）。
   */
  pruneHandles(keep: readonly string[]): Promise<number>;
  /**
   * 用令牌换回完整引用（主要是取回展示名）
   *
   * 需要它的原因：会话里只存令牌，而界面要显示目录名。
   * 换成别的机器/浏览器时令牌自然失效，此时返回 `FS_NOT_FOUND` ——
   * 这也正是"句柄不会跟着数据一起泄露"的体现。
   */
  describe(id: string): Promise<Result<WorkspaceRef>>;
  /** 查询某个引用当前的**读取**状态 */
  state(ref: WorkspaceRef): Promise<HandleState>;
  /**
   * 查询**写入**状态
   *
   * 与读取**分开**查，这不是啰嗦：拿到"可读"完全不代表"可写"。
   * 把两者混成一个状态，就会出现界面上写着"已开启"、实际每次都写不了 ——
   * 这是最难排查的一类问题，因为所有显示都是对的。
   */
  writeState(ref: WorkspaceRef): Promise<HandleState>;
  /**
   * 请求重新授权（读取）
   *
   * **必须由用户手势触发**（浏览器要求），所以只能被"点了按钮"这种路径调用。
   */
  requestAccess(ref: WorkspaceRef): Promise<Result<HandleState>>;
  /**
   * 申请**写入**权限
   *
   * 同样**必须由用户手势触发**。所以它只能被"点了开关 / 点了授权按钮"调用，
   * 绝不能在工具执行中途调用 —— 那里没有手势，只会拿到拒绝，
   * 而且报错信息会把原因指向错误的方向。
   */
  requestWriteAccess(ref: WorkspaceRef): Promise<Result<HandleState>>;
  /** 忘记一个引用（清空工作区时调用，避免句柄在 IndexedDB 里越积越多） */
  forget(ref: WorkspaceRef): Promise<void>;

  list(ref: WorkspaceRef, dir: string): Promise<Result<FsEntry[]>>;
  read(ref: WorkspaceRef, path: string): Promise<Result<string>>;
  write(ref: WorkspaceRef, path: string, content: string): Promise<Result<void>>;
}
