import {
  activeProfileOf,
  createModelProfile,
  type AppSettings,
  type AppSettingsPatch,
  type BalanceSettings,
  type ModelProfile,
} from '@domain/value-objects/appSettings';

/*
 * 模型配置：所有编辑都打到「当前生效的那一份」上
 *
 * 「什么端点 + 什么凭据 + 什么模型名 + 怎么查余额」是一件事，
 * 所以它们存在同一个配置里；编辑时也只改当前这一份，不碰其它配置。
 *
 * 这三个函数从 `SettingsPanel` 搬到这里：它们只服务模型分区，
 * 留在面板里会变成"面板知道模型分区的内部细节"。
 */
export function patchProfile(settings: AppSettings, patch: Partial<ModelProfile>): AppSettingsPatch {
  const target = activeProfileOf(settings);
  if (!target) return {};
  return {
    model: {
      profiles: settings.model.profiles.map((item) =>
        item.id === target.id ? { ...item, ...patch } : item,
      ),
    },
  };
}

export function patchBalance(settings: AppSettings, patch: Partial<BalanceSettings>): AppSettingsPatch {
  const target = activeProfileOf(settings);
  if (!target) return {};
  return patchProfile(settings, { balance: { ...target.balance, ...patch } });
}

/** 读当前配置的字段，配置不存在时给一个合理的空值 */
export function profileOf(settings: AppSettings): ModelProfile {
  return activeProfileOf(settings) ?? createModelProfile({ id: '', name: '' });
}
