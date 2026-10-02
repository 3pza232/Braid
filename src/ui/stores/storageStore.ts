import { create } from 'zustand';
import type { StorageStatus } from '@ports/host/SqlPort';

/**
 * 本地存储状态（只读诊断信息）
 *
 * 启动流程完成迁移后写入一次，设置页的「关于」读它。
 * 这样"存储是否就绪、跑在什么引擎上、结构版本是多少"对用户是可见的 ——
 * 出问题时不用翻控制台。
 */
interface StorageState {
  status: StorageStatus;
  set: (status: StorageStatus) => void;
}

const INITIAL: StorageStatus = {
  ready: false,
  engine: '未初始化',
  // 装载前不报警：durable 未知时按"没问题"处理，避免启动瞬间闪一条吓人的提示
  durable: true,
  grantedPersist: false,
  origin: '',
  recreated: false,
  schemaVersion: 0,
  applied: [],
  error: null,
  counts: { roles: 0, settings: 0 },
};

export const useStorageStore = create<StorageState>((set) => ({
  status: INITIAL,
  set: (status) => set({ status }),
}));
