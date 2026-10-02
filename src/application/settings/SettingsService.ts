import type {
  AppSettings,
  AppSettingsPatch,
} from '@domain/value-objects/appSettings';
import {
  DEFAULT_APP_SETTINGS,
  mergeAppSettings,
  pickSettingsShape,
  toPersistableSettings,
} from '@domain/value-objects/appSettings';
import type { SettingStore } from '@ports/repositories/SettingStore';
import type { SettingsApi } from '@ports/SettingsApi';
import { ok, type Result } from '@shared/result';

const SETTINGS_KEY = 'app.settings';

/**
 * 全局设置服务（应用层）
 *
 * 为什么设置不走 store 而走服务？
 * 因为"读默认值 → 合并补丁 → 过滤未知字段 → 落盘时擦掉密钥"这一串是**业务规则**，
 * 不是视图状态。放在这里，它就能脱离 React 单测；store 只负责把它镜像给界面。
 *
 * 三层优先级中的最底层（全局默认）由它持有：
 *   全局默认 → 角色预设 → 会话覆盖
 */
export class SettingsService implements SettingsApi {
  private current: AppSettings = DEFAULT_APP_SETTINGS;
  private loaded = false;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly store: SettingStore) {}

  get(): AppSettings {
    return this.current;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** 启动时调用一次：读取落盘数据并与默认值合并，因此**新增设置项会自动获得默认值** */
  async load(): Promise<Result<AppSettings>> {
    const result = await this.store.get<unknown>(SETTINGS_KEY);
    if (!result.ok) return result;

    if (result.data !== null && result.data !== undefined) {
      this.current = mergeAppSettings(DEFAULT_APP_SETTINGS, pickSettingsShape(result.data));
    }
    this.loaded = true;
    this.emit();
    return ok(this.current);
  }

  /**
   * 更新设置
   *
   * 乐观更新：先改内存并通知订阅者（界面立刻响应），再异步落盘。
   * 落盘失败时把错误返回给调用方提示，但**不回滚界面**——
   * 用户已经看到并依赖这个状态，回滚会造成更大的困惑。
   */
  async update(patch: AppSettingsPatch): Promise<Result<AppSettings>> {
    this.current = mergeAppSettings(this.current, patch);
    this.emit();

    // 落盘前擦掉 API Key：密钥永不进入持久化数据（ADR-020）
    const persisted = await this.store.set(SETTINGS_KEY, toPersistableSettings(this.current));
    return persisted.ok ? ok(this.current) : persisted;
  }

  /** 重置为出厂默认 */
  async reset(): Promise<Result<AppSettings>> {
    this.current = structuredClone(DEFAULT_APP_SETTINGS);
    this.emit();
    const persisted = await this.store.set(SETTINGS_KEY, toPersistableSettings(this.current));
    return persisted.ok ? ok(this.current) : persisted;
  }

  subscribe(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
