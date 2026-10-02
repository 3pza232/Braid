import { appError, err, ok, type Result } from '@shared/result';
import { normalizeWorkspaceDir } from '@domain/rules/workspacePath';
import {
  resolveWorkspacePermission,
  type ResolvedWorkspacePermission,
  type WorkspaceSettings,
} from '@domain/value-objects/workspace';
import type { FsEntry, FileSystemPort, HandleState, WorkspaceRef } from '@ports/host/FileSystemPort';
import type { WorkspaceAlert, WorkspaceApi, WorkspaceSnapshot } from '@ports/WorkspaceApi';

/**
 * 工作区的作用域
 *
 * 服务需要知道"当前这条对话选的是哪个目录、编辑开关怎么样"。
 * 这三件事分别住在**会话**与**设置**里，而服务既不该持有会话仓储，
 * 也不该持有设置服务 —— 那会把"工作区"和"聊天"耦合死。
 *
 * 所以改用三个取值函数注入：谁装配容器谁负责把它们接起来
 * （组合根知道会话在哪、设置在哪）。这同时让单测可以不启动任何仓储就测完服务。
 */
export interface WorkspaceScope {
  /** 当前会话的工作区令牌（`null` = 未选择） */
  root(): string | null;
  /** 会话级的"允许编辑"覆盖（`null` = 继承全局） */
  override(): boolean | null;
  /** 全局"允许编辑"默认值 */
  global(): WorkspaceSettings;
  /** 把新令牌写回当前会话（由会话契约完成持久化） */
  setRoot(root: string | null): Promise<void>;
}

const EMPTY_PERMISSION: ResolvedWorkspacePermission = { allowEdit: false, source: 'global' };

export class WorkspaceService implements WorkspaceApi {
  private loaded = false;
  private root: WorkspaceRef | null = null;
  private handleState: HandleState = 'missing';
  private writeState: HandleState = 'missing';
  private permission: ResolvedWorkspacePermission = EMPTY_PERMISSION;
  private entries: FsEntry[] = [];
  private error: string | null = null;

  /** 已加载的令牌，用来判断"会话切换后是否需要重新加载" */
  private loadedRootToken: string | null = null;

  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly alertListeners = new Set<(alert: WorkspaceAlert) => void>();

  constructor(
    private readonly fs: FileSystemPort,
    private readonly scope: WorkspaceScope,
  ) {}

  snapshot(): WorkspaceSnapshot {
    return {
      loaded: this.loaded,
      root: this.root,
      handleState: this.handleState,
      writeState: this.writeState,
      canRead: this.root !== null && this.handleState === 'granted',
      // 三件事都要成立才叫"能写"：选中目录、浏览器给了写入权、我们的开关开着
      canWrite:
        this.root !== null &&
        this.handleState === 'granted' &&
        this.writeState === 'granted' &&
        this.permission.allowEdit,
      permission: this.permission,
      supported: this.fs.supported,
      unsupportedReason: this.fs.unsupportedReason,
      entries: this.entries,
      error: this.error,
    };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAlerts(listener: (alert: WorkspaceAlert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  /**
   * 装载（或会话切换后重新装载）
   *
   * 权限每次都重新解析而不是缓存：用户可能在设置里刚打开开关，
   * 缓存住就会出现"明明开了还是不让写"这种最难查的一类 bug。
   */
  async load(): Promise<Result<WorkspaceSnapshot>> {
    const token = this.scope.root();
    this.loadedRootToken = token;
    this.permission = resolveWorkspacePermission({
      global: this.scope.global(),
      override: this.scope.override(),
    });

    if (!token) {
      this.root = null;
      this.handleState = 'missing';
      this.writeState = 'missing';
      this.entries = [];
      this.error = null;
      return this.commit();
    }

    const refResult = await this.fs.describe(token);
    if (!refResult.ok) {
      // 令牌在库里有、但本机换不到句柄：不当作错误，而是"需要重新选择"
      this.root = null;
      this.handleState = 'missing';
      this.writeState = 'missing';
      this.entries = [];
      this.error = refResult.error.message;
      return this.commit();
    }

    this.root = refResult.data;
    this.handleState = await this.fs.state(refResult.data);
    // 读取与写入**分开查**：可读不代表可写，混在一起就会显示"已开启"却写不了
    this.writeState = await this.fs.writeState(refResult.data);
    this.error = null;
    // 授权到位就顺手把目录列出来：用户刚选完目录，最想看的就是"里面有什么"
    if (this.handleState === 'granted') await this.refresh();
    return this.commit();
  }

  /**
   * 若当前会话的工作区令牌变了就重新装载
   *
   * 由组合根在会话变化时调用。**先比对再动手**，因为它会被高频调用
   * （会话每次 emit 都会触发，包括流式输出的每一个字）：
   * 不加判断就会变成"每输出一个字就重读一遍目录"。
   */
  async syncScope(): Promise<void> {
    const next = resolveWorkspacePermission({
      global: this.scope.global(),
      override: this.scope.override(),
    });
    // 权限真的变了才值得通知界面。否则每次调用都 emit 会让整棵树白白重渲染
    const permissionChanged =
      next.allowEdit !== this.permission.allowEdit || next.source !== this.permission.source;
    this.permission = next;

    if (this.scope.root() === this.loadedRootToken) {
      if (permissionChanged) this.emit();
      return;
    }
    await this.load();
  }

  async selectDirectory(): Promise<Result<WorkspaceRef | null>> {
    /*
     * 权限**一次要够**
     *
     * 已经允许编辑时就顺带申请写入权限。这是唯一可行的时机：
     * 弹目录选择器的这一次点击同时是"用户手势"和"授权弹窗出现的地方"。
     * 事后再补申请（工具执行到一半）没有手势，只会失败。
     */
    const mode = this.permission.allowEdit ? 'readwrite' : 'read';
    const picked = await this.fs.pickDirectory({ mode });
    if (!picked.ok) return picked;
    // 用户取消：什么都不改，会话里原来的目录保持不变
    if (picked.data === null) return ok(null);

    await this.scope.setRoot(picked.data.id);
    await this.load();
    return ok(picked.data);
  }

  async clearDirectory(): Promise<Result<void>> {
    if (this.root) await this.fs.forget(this.root);
    await this.scope.setRoot(null);
    await this.load();
    return ok(undefined);
  }

  /**
   * 清理孤儿句柄
   *
   * 只做转发：真正的判断（哪些记录没人引用）在文件系统适配层，
   * 因为"谁在用"这件事由调用方（组合根）算完传进来 —— 服务不该去查会话仓储。
   */
  async pruneHandles(keep: readonly string[]): Promise<Result<number>> {
    return ok(await this.fs.pruneHandles(keep));
  }

  async reauthorize(): Promise<Result<HandleState>> {
    if (!this.root) {
      return err(appError('FS_NOT_FOUND', '还没有选择工作区目录'));
    }
    const result = await this.fs.requestAccess(this.root);
    if (!result.ok) return result;

    this.handleState = result.data;
    this.writeState = await this.fs.writeState(this.root);
    if (result.data === 'granted') {
      this.error = null;
      await this.refresh();
    } else {
      this.commit();
    }
    return result;
  }

  /**
   * 申请**写入**授权
   *
   * 必须由界面在用户点击的处理函数里调用（浏览器只认用户手势）。
   * 界面用法：打开编辑开关 → 先 await 本方法 → 授权成功才真的打开开关。
   * 反过来（先开开关、事后补申请）拿不到手势，必然失败。
   */
  async authorizeWrite(): Promise<Result<HandleState>> {
    const guard = this.requireRoot();
    if (!guard.ok) return guard;

    const result = await this.fs.requestWriteAccess(guard.data);
    if (!result.ok) return result;

    this.writeState = result.data;
    this.commit();
    return result;
  }

  async refresh(dir = ''): Promise<Result<FsEntry[]>> {
    if (!this.root) {
      this.entries = [];
      return ok([]);
    }
    const verdict = normalizeWorkspaceDir(dir);
    if (!verdict.ok) return err(appError('FS_PATH_DENIED', verdict.message));

    const result = await this.fs.list(this.root, verdict.path);
    if (!result.ok) {
      this.error = result.error.message;
      // 列目录失败往往意味着句柄失效，顺手重新探测一次状态，
      // 让界面能给出"需要重新授权"而不是一句笼统的失败
      this.handleState = await this.fs.state(this.root);
      this.commit();
      return result;
    }

    this.entries = result.data;
    this.error = null;
    this.commit();
    return result;
  }

  /**
   * 列目录，不改动界面状态
   *
   * 供文件工具使用：模型翻看子目录是它的探查动作，
   * 不该把用户面板里的列表顶掉。
   */
  async listFiles(dir = ''): Promise<Result<FsEntry[]>> {
    const guard = this.requireRoot();
    if (!guard.ok) return guard;
    if (this.handleState !== 'granted') {
      return err(appError('FS_PATH_DENIED', '工作区目录尚未授权，请先点击授权'));
    }
    const verdict = normalizeWorkspaceDir(dir);
    if (!verdict.ok) return err(appError('FS_PATH_DENIED', verdict.message));
    return this.fs.list(guard.data, verdict.path);
  }

  /** 读文件：**不需要任何开关**（见 domain/value-objects/workspace.ts 的说明） */
  async readFile(path: string): Promise<Result<string>> {
    const guard = this.requireRoot();
    if (!guard.ok) return guard;
    if (this.handleState !== 'granted') {
      return err(appError('FS_PATH_DENIED', '工作区目录尚未授权，请先点击授权'));
    }
    return this.fs.read(guard.data, path);
  }

  /**
   * 写文件 —— 本功能的核心门禁
   *
   * 顺序刻意写成"先查权限、再碰磁盘"：
   * 未授权时**连底层写接口都不会被调用**，而不是"写了再回滚"。
   * 拒绝时同时发生两件事：
   *   1. 给用户发一条警报（界面弹通知，说清是哪个开关没开）；
   *   2. 返回 `FS_EDIT_DENIED`，让调用方（M3 的工具循环）把它变成
   *      一条失败的 `tool_result` 交给模型 —— 模型据此知道"改不了"，
   *      而不是以为改成功了继续往下编。
   */
  async writeFile(path: string, content: string): Promise<Result<void>> {
    const guard = this.requireRoot();
    if (!guard.ok) {
      this.raise(guard.error.code, guard.error.message);
      return guard;
    }

    if (this.handleState !== 'granted') {
      const message = '工作区目录尚未授权，请先点击「重新授权」';
      this.raise('FS_PATH_DENIED', message);
      return err(appError('FS_PATH_DENIED', message));
    }

    if (!this.permission.allowEdit) {
      const where = this.permission.source === 'global' ? '全局设置' : '本会话设置';
      const message = `编辑工作区文件未获授权：请在${where}里打开「允许编辑工作区文件」后再试`;
      this.raise('FS_EDIT_DENIED', message);
      return err(
        appError('FS_EDIT_DENIED', message, {
          detail: { path, permissionSource: this.permission.source },
        }),
      );
    }

    /*
     * 第二道门：**浏览器的写入授权**
     *
     * 开关开着 ≠ 写得了。浏览器对目录的授权分读、写两种，写入授权只在
     * 用户点开关的那一刻才能申请到。所以这里必须把"缺的是哪一样"说清楚：
     * 缺开关 → 让用户去开开关；缺授权 → 让用户去点授权。
     * 混成一句"没权限"，用户和模型都会找错方向。
     */
    if (this.writeState !== 'granted') {
      const message =
        this.writeState === 'missing'
          ? '工作区目录已不可用（可能被移动或删除），请重新选择目录'
          : '浏览器还没有授予这个目录的「写入」权限。请在设置里点一次「授权写入」后重试';
      this.raise('FS_EDIT_DENIED', message);
      return err(
        appError('FS_EDIT_DENIED', message, { detail: { path, writeState: this.writeState } }),
      );
    }

    return this.fs.write(guard.data, path, content);
  }

  private requireRoot(): Result<WorkspaceRef> {
    if (!this.root) {
      return err(appError('FS_NOT_FOUND', '当前会话还没有选择工作区目录'));
    }
    return ok(this.root);
  }

  private raise(code: WorkspaceAlert['code'], message: string): void {
    const alert: WorkspaceAlert = {
      id: `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      code,
      message,
    };
    for (const listener of this.alertListeners) listener(alert);
  }

  private commit(): Result<WorkspaceSnapshot> {
    this.loaded = true;
    this.emit();
    return ok(this.snapshot());
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
