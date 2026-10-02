import { create } from 'zustand';
import type { RolePreset } from '@domain/entities/rolePreset';
import type { RoleApi } from '@ports/RoleApi';
import type { RoleId } from '@shared/ids';

/**
 * 角色的「界面镜像」
 *
 * 与 settingsStore 同样的纪律：**不含任何业务规则**。
 * 校验、落盘、导入容错、出厂样例播种全部在 `RoleService`（应用层）里。
 *
 * 所有写操作都返回结果对象，方便界面在"新建后自动选中它"这类场景下拿到新 id。
 */
interface RolesState {
  roles: RolePreset[];
  loaded: boolean;
  error: string | null;
  bind: (api: RoleApi) => void;
  create: () => Promise<RolePreset | null>;
  save: (role: RolePreset) => void;
  duplicate: (id: RoleId) => Promise<RolePreset | null>;
  remove: (id: RoleId) => void;
  /** 手动排序：传当前可见顺序的 id 列表 */
  reorder: (orderedIds: RoleId[]) => void;
  importJson: (json: string) => Promise<RolePreset | null>;
  exportJson: (id: RoleId) => string;
  clearError: () => void;
}

let service: RoleApi | null = null;
let bound = false;

export const useRolesStore = create<RolesState>((set) => ({
  roles: [],
  loaded: false,
  error: null,

  bind: (api) => {
    if (bound) return;
    bound = true;
    service = api;

    api.subscribe((roles) => set({ roles, loaded: true }));

    /*
     * 订阅之后**同步拉一次当前值**：装载由组合根发起，可能在界面挂载之前就完成了，
     * 那时订阅会错过那次 emit —— 界面就会一直空着。这一句消除该竞态。
     */
    set({ roles: api.list(), loaded: api.isLoaded() });
  },

  create: async () => {
    if (!service) return null;
    const result = await service.create();
    if (!result.ok) {
      set({ error: result.error.message });
      return null;
    }
    return result.data;
  },

  save: (role) => {
    void service?.upsert(role).then((result) => {
      if (result && !result.ok) set({ error: result.error.message });
    });
  },

  duplicate: async (id) => {
    if (!service) return null;
    const result = await service.duplicate(id);
    if (!result.ok) {
      set({ error: result.error.message });
      return null;
    }
    return result.data;
  },

  remove: (id) => {
    void service?.remove(id).then((result) => {
      if (result && !result.ok) set({ error: result.error.message });
    });
  },

  reorder: (orderedIds) => {
    void service?.reorder(orderedIds).then((result) => {
      if (result && !result.ok) set({ error: result.error.message });
    });
  },

  importJson: async (json) => {
    if (!service) return null;
    const result = await service.importFromJson(json);
    if (!result.ok) {
      set({ error: result.error.message });
      return null;
    }
    if (!result.data) {
      set({ error: 'JSON 解析失败：内容不是合法的角色配置' });
      return null;
    }
    return result.data;
  },

  exportJson: (id) => {
    if (!service) return '';
    const result = service.exportToJson(id);
    return result.ok ? result.data : '';
  },

  clearError: () => set({ error: null }),
}));
