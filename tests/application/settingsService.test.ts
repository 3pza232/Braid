import { describe, expect, it } from 'vitest';
import { SettingsService } from '@app/settings/SettingsService';
import { DEFAULT_APP_SETTINGS } from '@domain/value-objects/appSettings';
import type { SettingStore } from '@ports/repositories/SettingStore';
import { appError, err, ok, type Result } from '@shared/result';

/**
 * 设置服务
 *
 * 它是**零覆盖**模块里最该补的一个：三条关键不变量都只在这里成立，
 * 而它们出错时的表现都很隐蔽 ——
 *  1. 新增设置项要自动获得默认值（否则升级后老用户拿到 `undefined`）；
 *  2. 库里的坏数据要回落默认而不是把界面炸掉；
 *  3. **密钥永不进入持久化数据**（ADR-020）：写盘前必须擦掉。
 */
const KEY = 'app.settings';

function createFakeStore(seed: unknown = null): {
  store: SettingStore;
  written: () => unknown;
} {
  let stored: unknown = seed;
  return {
    store: {
      get: async <T,>() => ok((stored as T) ?? null) as Result<T | null>,
      set: async (_key, value) => {
        stored = value;
        return ok(undefined);
      },
      remove: async () => ok(undefined),
      getAll: async () => ok({ [KEY]: stored }),
    },
    written: () => stored,
  };
}

describe('SettingsService', () => {
  it('装载时与默认值合并：库里缺的字段自动拿到默认值', async () => {
    // 模拟"老版本只存了一个字段"
    const fake = createFakeStore({ identity: { userName: '老王' } });
    const service = new SettingsService(fake.store);

    const loaded = await service.load();

    expect(loaded.ok).toBe(true);
    // 存过的保留
    expect(service.get().identity.userName).toBe('老王');
    // 没存过的（新版本才有的项）回落默认，而不是 undefined
    expect(service.get().appearance).toEqual(DEFAULT_APP_SETTINGS.appearance);
  });

  it('库里的坏数据不会把界面炸掉（回落默认）', async () => {
    const fake = createFakeStore('这不是一个设置对象');
    const service = new SettingsService(fake.store);

    const loaded = await service.load();

    expect(loaded.ok).toBe(true);
    expect(service.get()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('落盘前擦掉密钥（ADR-020：密钥永不进入持久化数据）', async () => {
    const fake = createFakeStore();
    const service = new SettingsService(fake.store);
    await service.load();

    await service.update({
      model: {
        profiles: [
          {
            ...DEFAULT_APP_SETTINGS.model.profiles[0]!,
            apiKey: 'sk-绝密-不该落盘',
          },
        ],
        activeProfileId: DEFAULT_APP_SETTINGS.model.activeProfileId,
      },
    });

    // 内存里用户正常用着（界面需要它）
    expect(service.get().model.profiles[0]?.apiKey).toBe('sk-绝密-不该落盘');
    // 写进去的那份里一个字都不能有
    expect(JSON.stringify(fake.written())).not.toContain('sk-绝密-不该落盘');
  });

  it('乐观更新：落盘失败也**不回滚**内存状态，但把错误交回调用方', async () => {
    const failing: SettingStore = {
      get: async <T,>() => ok(null) as Result<T | null>,
      set: async () => err(appError('STORAGE_ERROR', '磁盘满了')),
      remove: async () => ok(undefined),
      getAll: async () => ok({}),
    };
    const service = new SettingsService(failing);
    await service.load();

    const result = await service.update({ composer: { ...DEFAULT_APP_SETTINGS.composer, maxInputHeight: 321 } });

    expect(result.ok).toBe(false);
    // 用户已经看到并依赖这个状态：回滚会造成更大的困惑（见服务里的说明）
    expect(service.get().composer.maxInputHeight).toBe(321);
  });

  it('重置回出厂默认，并同样擦掉密钥后落盘', async () => {
    const fake = createFakeStore();
    const service = new SettingsService(fake.store);
    await service.update({ identity: { ...DEFAULT_APP_SETTINGS.identity, userName: '临时' } });

    const reset = await service.reset();

    expect(reset.ok).toBe(true);
    expect(service.get().identity.userName).toBe(DEFAULT_APP_SETTINGS.identity.userName);
    expect(JSON.stringify(fake.written())).not.toContain('sk-');
  });

  it('订阅者在每次变更后收到最新值', async () => {
    const service = new SettingsService(createFakeStore().store);
    const seen: string[] = [];
    service.subscribe((settings) => seen.push(settings.identity.userName));

    await service.update({ identity: { ...DEFAULT_APP_SETTINGS.identity, userName: '甲' } });
    await service.update({ identity: { ...DEFAULT_APP_SETTINGS.identity, userName: '乙' } });

    expect(seen).toEqual(['甲', '乙']);
  });
});
