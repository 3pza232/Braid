import { activeProfileOf } from '@domain/value-objects/appSettings';
import type { BalanceSnapshot } from '@domain/value-objects/billing';
import type { BalanceApi } from '@ports/BalanceApi';
import type { BalanceProvider } from '@ports/BalanceProvider';
import type { SettingsApi } from '@ports/SettingsApi';
import { ok, type Result } from '@shared/result';

/**
 * 余额服务（应用层）
 *
 * 只做三件事：
 *  1. 从设置里拿用户写的脚本；
 *  2. 交给 `BalanceProvider` 去跑（真正发请求与解析在适配层）；
 *  3. 缓存最近一次结果并广播给界面。
 *
 * 脚本为空时**不请求、不显示** —— 不内置任何厂商假设。
 */
export class BalanceService implements BalanceApi {
  private snapshot: BalanceSnapshot | null = null;
  private busy = false;
  private readonly listeners = new Set<(snapshot: BalanceSnapshot | null) => void>();
  private readonly busyListeners = new Set<(busy: boolean) => void>();

  constructor(
    private readonly provider: BalanceProvider,
    private readonly settings: SettingsApi,
  ) {}

  get(): BalanceSnapshot | null {
    return this.snapshot;
  }

  isRefreshing(): boolean {
    return this.busy;
  }

  async refresh(): Promise<Result<BalanceSnapshot | null>> {
    /*
     * 余额脚本现在**跟着模型配置走**：不同端点的余额接口完全不同，
     * 把它们分开放在两个设置页里，用户改端点时必然会忘了改余额脚本。
     */
    const profile = activeProfileOf(this.settings.get());
    const script = profile?.balance.script.trim() ?? '';

    if (!profile || !script) {
      this.setSnapshot(null);
      return ok(null);
    }

    this.setBusy(true);
    try {
      const result = await this.provider.probe(script, {
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        timeoutMs: 15_000,
      });

      if (!result.ok) {
        this.setSnapshot({
          isValid: false,
          remaining: null,
          unit: '',
          fetchedAt: Date.now(),
          error: result.error.message,
        });
        return ok(this.snapshot);
      }

      this.setSnapshot(result.data);
      return ok(this.snapshot);
    } finally {
      this.setBusy(false);
    }
  }

  subscribe(listener: (snapshot: BalanceSnapshot | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeBusy(listener: (busy: boolean) => void): () => void {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  }

  private setSnapshot(snapshot: BalanceSnapshot | null): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const listener of this.busyListeners) listener(busy);
  }
}
