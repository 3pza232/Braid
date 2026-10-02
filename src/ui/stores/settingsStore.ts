import { create } from 'zustand';
import type {
  AppSettings,
  AppSettingsPatch,
} from '@domain/value-objects/appSettings';
import { DEFAULT_APP_SETTINGS } from '@domain/value-objects/appSettings';
import type { SettingsApi } from '@ports/SettingsApi';

/**
 * 设置的「界面镜像」
 *
 * 这个 store **不含任何业务规则**：读默认值、合并补丁、擦除密钥、落盘
 * 全部由 `SettingsService`（应用层）负责。store 只做两件事：
 *  1. 订阅服务的变化并镜像成本地状态，供 React 订阅；
 *  2. 把界面上的操作转发给服务。
 *
 * 这样设置逻辑可以脱离 React 单测，未来换 UI 框架时业务零改动。
 */
interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  error: string | null;
  bind: (api: SettingsApi) => void;
  update: (patch: AppSettingsPatch) => void;
  reset: () => void;
}

let service: SettingsApi | null = null;
let bound = false;

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_APP_SETTINGS,
  loaded: false,
  error: null,

  bind: (api) => {
    if (bound) return;
    bound = true;
    service = api;

    api.subscribe((settings) => set({ settings, loaded: true }));

    // 同 rolesStore：同步拉一次当前值，避免装载早于订阅而导致界面一直显示默认值
    set({ settings: api.get(), loaded: api.isLoaded() });
  },

  /*
   * 成败都要写一次
   *
   * 早先只在失败时 `set({ error })`，成功时什么都不做 —— 于是保存失败过一次之后，
   * 那行红字会**永久挂在设置页**：之后再怎么成功保存也不消失，用户会以为
   * "设置一直是坏的"。成功即清空，错误才有"当前状态"的含义。
   */
  update: (patch) => {
    void service?.update(patch).then((result) => {
      set({ error: result && !result.ok ? result.error.message : null });
    });
  },

  reset: () => {
    void service?.reset().then((result) => {
      set({ error: result && !result.ok ? result.error.message : null });
    });
  },
}));
