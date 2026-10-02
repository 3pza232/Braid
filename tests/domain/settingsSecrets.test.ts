import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, toPersistableSettings } from '@domain/value-objects/appSettings';

/**
 * 落盘前的密钥净化
 *
 * 设置整份存在 `setting` 表的一行里，而 API Key 就住在其中某个字段上。
 * 一旦它跟着落盘，任何能读到这台机器上的浏览器数据的人都能看到它 ——
 * 这是一条**不可逆**的泄露：写入之后没有"撤回"。
 *
 * 所以这里测的不是"`apiKey` 字段被清空了"（那只证明我知道这一个字段），
 * 而是**整份序列化结果里不出现密钥**：将来任何人往设置里加一个装密钥的字段，
 * 只要忘了净化，这些用例就会红。
 */
const SECRET = 'sk-绝密-不该落盘-0123456789';

function withKey(persistApiKey: boolean) {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.model.profiles = settings.model.profiles.map((profile) => ({
    ...profile,
    apiKey: SECRET,
    persistApiKey,
  }));
  return settings;
}

describe('落盘前的密钥净化', () => {
  it('默认：整份序列化结果里不含密钥', () => {
    const persisted = toPersistableSettings(withKey(false));

    // 逐字节扫描，而不是只看某个字段 —— 这才能拦住"新增了一个敏感字段"
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
    expect(persisted.model.profiles[0]?.apiKey).toBe('');
  });

  it('用户显式勾了「保存到本地」才写进去（这是他的选择，不是我们替他决定）', () => {
    const persisted = toPersistableSettings(withKey(true));

    expect(persisted.model.profiles[0]?.apiKey).toBe(SECRET);
    expect(persisted.model.profiles[0]?.persistApiKey).toBe(true);
  });

  it('不改动传入的设置：净化是纯函数，内存里还要继续用它发请求', () => {
    const settings = withKey(false);

    toPersistableSettings(settings);

    expect(settings.model.profiles[0]?.apiKey).toBe(SECRET);
  });
});
