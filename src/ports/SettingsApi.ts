import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import type { Result } from '@shared/result';

/**
 * 设置服务的对外契约
 *
 * 为什么要有这层接口，而不是让容器直接暴露 `SettingsService` 类？
 * 因为端口层不允许依赖应用层（见 [docs/01-architecture.md](../docs/01-architecture.md) 的分层规则）。
 * 声明接口后：
 *  - 容器契约（ports）可以引用它，而不必知道具体实现；
 *  - 表现层拿到的是一个**窄接口**，看不到服务内部的任何实现细节；
 *  - 单测里可以塞一个假实现，不需要真实存储。
 */
export interface SettingsApi {
  get(): AppSettings;
  isLoaded(): boolean;
  load(): Promise<Result<AppSettings>>;
  update(patch: AppSettingsPatch): Promise<Result<AppSettings>>;
  reset(): Promise<Result<AppSettings>>;
  subscribe(listener: (settings: AppSettings) => void): () => void;
}
