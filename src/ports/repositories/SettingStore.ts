import type { Result } from '@shared/result';

/**
 * 设置持久化端口
 *
 * 只暴露"按键读写 JSON"这一最小能力，因此可以有多套实现：
 *  - S1 阶段：`localStorageSettingStore`（快速跑通 UI）
 *  - S2 阶段：`SqliteSettingStore`（真正的本地数据库，与其它表同一个库）
 *
 * 换成 SQLite 时，`SettingsService` 与所有 UI 代码**零改动** —— 这就是端口隔离的价值。
 */
export interface SettingStore {
  get<T = unknown>(key: string): Promise<Result<T | null>>;
  set(key: string, value: unknown): Promise<Result<void>>;
  remove(key: string): Promise<Result<void>>;
  /** 一次性取出全部（用于导出与调试） */
  getAll(): Promise<Result<Record<string, unknown>>>;
}
