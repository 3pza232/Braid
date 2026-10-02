import { create } from 'zustand';
import type { BalanceSnapshot } from '@domain/value-objects/billing';
import type { BalanceApi } from '@ports/BalanceApi';

/**
 * 余额的「界面镜像」
 *
 * 余额接口完全由用户脚本决定（端口隔离），所以这里只管订阅与转发，
 * 不含任何"怎么请求、怎么解析"的知识。
 */
interface BalanceState {
  snapshot: BalanceSnapshot | null;
  busy: boolean;
  bind: (api: BalanceApi) => void;
  refresh: () => void;
  /** 立即跑一次脚本并返回剩余额度；未配置脚本或失败时返回 null */
  measure: () => Promise<number | null>;
}

let service: BalanceApi | null = null;
let bound = false;

export const useBalanceStore = create<BalanceState>((set) => ({
  snapshot: null,
  busy: false,

  bind: (api) => {
    if (bound) return;
    bound = true;
    service = api;

    api.subscribe((snapshot) => set({ snapshot }));
    api.subscribeBusy((busy) => set({ busy }));

    void api.refresh();
  },

  refresh: () => {
    void service?.refresh();
  },

  measure: async () => {
    if (!service) return null;
    const result = await service.refresh();
    if (!result.ok || !result.data) return null;
    return result.data.remaining;
  },
}));
