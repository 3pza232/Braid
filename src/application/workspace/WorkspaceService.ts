import { appError, err, ok, type Result } from '@shared/result';
import { normalizeWorkspaceDir } from '@domain/rules/workspacePath';
import type { FsEntry, FileSystemPort, HandleState, WorkspaceRef } from '@ports/host/FileSystemPort';
import type { WorkspaceAlert, WorkspaceApi, WorkspaceSnapshot } from '@ports/WorkspaceApi';

/**
 * 工作区的作用域
 *
 * 服务只需要知道一件事：**当前这条对话选的是哪个目录**。它住在会话里，
 * 而服务既不该持有会话仓储、也不该持有设置服务 —— 那会把"工作区"和"聊天"耦合死。
 *
 * 所以改用取值函数注入：谁装配容器谁负责接起来（组合根知道会话在哪）。
 * 这同时让单测可以不启动任何仓储就测完服务。
 *
 * 【早先这里有三个函数】还有"会话级覆盖"与"全局默认"两个，服务于一个
 * 三层开关（全局 / 会话 / 浏览器授权）。那个概念已经删掉了：**选中工作区
 * 就等于给了这个目录的读写权**（见 `writeFile` 的说明）。
 */
export interface WorkspaceScope {
  /** 当前会话的工作区令牌（`null` = 未选择） */
  root(): string | null;
  /** 把新令牌写回当前会话（由会话契约完成持久化） */
  setRoot(root: string | null): Promise<void>;
}

export class WorkspaceService implements WorkspaceApi {
  private loaded = false;
  private root: WorkspaceRef | null = null;
  private handleState: HandleState = 'missing';
  private writeState: HandleState = 'missing';
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
      // 两件事：选中目录 + 浏览器给了写入权（"我们的开关"那第三层已经删掉了）
      canWrite:
        this.root !== null &&
        this.handleState === 'granted' &&
        this.writeState === 'granted',
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

  /** 装载（或会话切换后重新装载） */
  async load(): Promise<Result<WorkspaceSnapshot>> {
    const token = this.scope.root();
    this.loadedRootToken = token;

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
    // 令牌没变就什么都不做（这个函数会被高频调用，见上面的说明）
    if (this.scope.root() === this.loadedRootToken) return;
    await this.load();
  }

  async selectDirectory(): Promise<Result<WorkspaceRef | null>> {
    /*
     * 权限**一次要够**
     *
     * 一律申请 `readwrite`。这是唯一可行的时机：弹目录选择器的这一次点击
     * 同时是"用户手势"和"授权弹窗出现的地方"。事后再补申请
     * （工具执行到一半）没有手势，只会失败。
     *
     * 早先是"开了编辑开关才要写权限"—— 那个开关没了，所以没得选：
     * 选中目录 = 给该目录读写权（这也是用户唯一能理解的说法）。
     */
    const picked = await this.fs.pickDirectory({ mode: 'readwrite' });
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

    /*
     * 拿到写入权之后**必须把读取状态也重查一遍**（所以这里走 `load()`）
     *
     * 浏览器给 `readwrite` 时读权限是一并给到的，而 `handleState` 很可能还停在
     * 'prompt'（重开应用后就是这样）。早先这里只写 `writeState` 再 commit，
     * 后果是：顶栏那颗「需授权」一直亮着，用户刚授权完还得再去会话设置里点一次
     * 「重新授权」—— 他会觉得"我刚点过，怎么没用"。
     * `load()` 会把两个状态、目录列表一起刷新，代价只是一次探测。
     */
    await this.load();
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

    /*
     * 这里曾经还有一道"编辑开关"的门（全局默认 + 会话覆盖）
     *
     * 那道门已经去掉：**选中工作区就等于给了这个目录的读写权** ——
     * 用户点开选择器、选中目录，本身就是同意（浏览器那次授权弹窗也是同一个手势）。
     * 三层开关（全局 / 会话 / 浏览器）只要有一层没对上，用户看到的就是
     * "我明明选了目录还是写不了"，而界面上看不出是哪一层的问题。
     */

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
