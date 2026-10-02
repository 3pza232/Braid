import { create } from 'zustand';
import type { WorkspaceAlert, WorkspaceApi, WorkspaceSnapshot } from '@ports/WorkspaceApi';
import type { HandleState } from '@ports/host/FileSystemPort';

/**
 * 工作区的「界面镜像」
 *
 * 与其它 store 同一套纪律：**不含任何业务规则**。
 * "能不能写"由 `WorkspaceService` 解析（会话覆盖 > 全局默认），
 * 这里只把解析结果搬给界面。
 */
interface WorkspaceState {
  snapshot: WorkspaceSnapshot;
  /** 待展示的警报（未授权编辑等）。展示过就移除，不做历史记录 */
  alerts: WorkspaceAlert[];
  /** 操作失败（选择目录、列目录…）。与警报分开：一个是权限事件，一个是操作失败 */
  error: string | null;

  bind: (api: WorkspaceApi) => void;
  /** 选目录：弹系统选择器并写进当前会话 */
  selectDirectory: () => Promise<void>;
  clearDirectory: () => Promise<void>;
  reauthorize: () => Promise<void>;
  /**
   * 申请写入授权
   *
   * 返回是否拿到了授权 —— 界面要**据此决定**要不要真的打开编辑开关。
   * 先开开关再申请是拿不到授权的（浏览器只认用户手势）。
   */
  authorizeWrite: () => Promise<boolean>;
  refresh: () => Promise<void>;
  dismissAlert: (id: string) => void;
  clearError: () => void;
}

/** 警报自动消失的时间：够看清一句话，又不至于一直挡着界面 */
const ALERT_TTL_MS = 12_000;

let service: WorkspaceApi | null = null;
let bound = false;

export const useWorkspaceStore = create<WorkspaceState>((set) => {
  /**
   * 统一"转发 + 收集错误"，与 chatStore 的 run 同一套写法
   *
   * 唯一的区别是**返回 Promise**：工作区的动作是用户点出来的，
   * 调用方能 await 就知道"授权到底成没成"（例如点完"重新授权"想立刻刷新列表）。
   */
  const run = (
    task: (api: WorkspaceApi) => Promise<{ ok: boolean; error?: { message: string } }>,
  ): Promise<void> => {
    if (!service) return Promise.resolve();
    return task(service).then((result) => {
      if (!result.ok && result.error) set({ error: result.error.message });
    });
  };

  return {
    snapshot: {
      loaded: false,
      root: null,
      handleState: 'missing' as HandleState,
      writeState: 'missing' as HandleState,
      canRead: false,
      canWrite: false,
      supported: true,
      unsupportedReason: null,
      entries: [],
      error: null,
    },
    alerts: [],
    error: null,

    bind: (api) => {
      if (bound) return;
      bound = true;
      service = api;

      api.subscribe((snapshot) => set({ snapshot }));

      /*
       * 警报只在"界面挂载之后"才有意义，但服务可能在挂载前就发过警报
       * （例如启动时自动重试读取失败）。所以绑定时机就是订阅时机 ——
       * 早于挂载的警报会丢，这是有意的：那种情况下用户还没在看界面，
       * 而"允许编辑"的警报必然由一次实际写入触发，不会在启动阶段产生。
       */
      api.subscribeAlerts((alert) => {
        set((state) => ({ alerts: [...state.alerts, alert] }));
        window.setTimeout(() => {
          set((state) => ({ alerts: state.alerts.filter((item) => item.id !== alert.id) }));
        }, ALERT_TTL_MS);
      });

      // 同步拉一次当前值：装载由组合根发起，可能早于界面挂载，那时订阅会错过 emit
      set({ snapshot: api.snapshot() });
    },

    selectDirectory: () => run((api) => api.selectDirectory()),
    clearDirectory: () => run((api) => api.clearDirectory()),
    reauthorize: () => run((api) => api.reauthorize()),
    refresh: () => run((api) => api.refresh()),

    async authorizeWrite() {
      if (!service) return false;
      const result = await service.authorizeWrite();
      if (!result.ok) {
        set({ error: result.error.message });
        return false;
      }
      if (result.data !== 'granted') {
        set({ error: '浏览器没有授予写入权限。你也可以重新选择一次目录，在选择时一并授权' });
        return false;
      }
      return true;
    },

    dismissAlert: (id) => set((state) => ({ alerts: state.alerts.filter((item) => item.id !== id) })),
    clearError: () => set({ error: null }),
  };
});
