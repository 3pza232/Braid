import { describe, expect, it } from 'vitest';
import {
  createEmptyRole,
  deserializeRole,
  serializeRole,
  type RolePreset,
} from '@domain/entities/rolePreset';
import { asRoleId } from '@shared/ids';

/**
 * 角色的导入 / 导出往返
 *
 * 这里守的是一条容易被忽略的规则：`deserializeRole` 的「已知字段清单」
 * 漏一个键，那个字段就会**静默降级** —— 值被塞进 `extensions`（位置不对、读不到），
 * 类型字段回落成默认值。曾经漏过 `modelProfileId`：
 * 导入带模型配置的角色后，配置悄悄没了，界面上完全看不出来。
 */
describe('角色序列化往返', () => {
  const makeRole = (overrides: Partial<RolePreset> = {}): RolePreset => ({
    ...createEmptyRole(asRoleId('role-1'), 1000),
    name: '写手',
    ...overrides,
  });

  const roundTrip = (role: RolePreset): RolePreset | null =>
    deserializeRole(serializeRole(role), asRoleId('role-2'), 2000);

  it('modelProfileId 往返不丢', () => {
    const back = roundTrip(makeRole({ modelProfileId: 'profile-2' }));

    expect(back?.modelProfileId).toBe('profile-2');
  });

  it('常用字段整体往返一致', () => {
    const role = makeRole({
      description: '写小说用',
      tags: ['写作', '长文'],
      systemPrompt: '你是一位编辑',
      greeting: '你好',
      assistantName: '小笔',
      userName: '老板',
      model: 'some-model',
      writingMode: 'long',
      variables: { tone: '克制' },
    });

    const back = roundTrip(role);

    expect(back).toMatchObject({
      name: role.name,
      description: role.description,
      tags: role.tags,
      systemPrompt: role.systemPrompt,
      greeting: role.greeting,
      assistantName: role.assistantName,
      userName: role.userName,
      model: role.model,
      writingMode: role.writingMode,
      variables: role.variables,
    });
  });

  it('未知字段进 extensions 透传（别人分享的角色不该因为版本差异失败）', () => {
    const back = roundTrip(makeRole({ extensions: { futureField: 42 } }));

    expect(back?.extensions).toMatchObject({ futureField: 42 });
  });

  it('排序位不跟着角色文件走：顺序是本地状态', () => {
    const back = roundTrip(makeRole({ sortOrder: 3 }));

    // 导入后落到末尾（null = 没排过），既不该插队，也不该污染 extensions
    expect(back?.sortOrder).toBeNull();
    expect(back?.extensions ?? {}).not.toHaveProperty('sortOrder');
  });

  it('坏 JSON 返回 null，而不是抛异常', () => {
    expect(deserializeRole('{ 不是 json', asRoleId('role-3'), 1000)).toBeNull();
  });
});
