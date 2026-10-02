import { describe, expect, it } from 'vitest';
import { RoleService } from '@app/role/RoleService';
import { createEmptyRole } from '@domain/entities/rolePreset';
import type { RolePreset } from '@domain/entities/rolePreset';
import type { RoleStore } from '@ports/repositories/RoleStore';
import { asRoleId } from '@shared/ids';
import { ok } from '@shared/result';

/**
 * 角色顺序：装载、新建、复制、导入的落位
 *
 * 与会话同一类契约（见 `conversationOrderPersistence.test.ts`）：顺序存在行上的
 * `sort_order` 里，**装载时必须按它重排**，而"新来的那一项"要有确定的落点。
 *
 * 角色的特殊之处是它有三个"新项"入口（新建 / 复制 / 导入），
 * 后两个早先都会把来源的编号一起带进来 —— 两行同号时顺序只能靠兜底规则，
 * 表现出来就是"复制/导入进来的角色位置很随机"。
 */

function createFakeStore(seed: RolePreset[] = []) {
  const roles = [...seed];
  let seeded = false;

  const store: RoleStore = {
    getAll: async () => ok(roles),
    save: async (role) => {
      const index = roles.findIndex((item) => item.id === role.id);
      if (index >= 0) roles[index] = role;
      else roles.push(role);
      return ok(undefined);
    },
    saveMany: async (items) => {
      for (const item of items) {
        const index = roles.findIndex((role) => role.id === item.id);
        if (index >= 0) roles[index] = item;
        else roles.push(item);
      }
      return ok(undefined);
    },
    remove: async (id) => {
      const index = roles.findIndex((item) => item.id === id);
      if (index >= 0) roles.splice(index, 1);
      return ok(undefined);
    },
    hasSeeded: async () => ok(seeded),
    markSeeded: async () => {
      seeded = true;
      return ok(undefined);
    },
  };

  return { store, roles };
}

const NOW = 1_700_000_000_000;

function role(name: string, sortOrder: number | null, updatedAt = NOW): RolePreset {
  return {
    ...createEmptyRole(asRoleId(`role-${name}`), NOW, { name }),
    sortOrder,
    updatedAt,
  };
}

describe('角色顺序', () => {
  it('装载时按手动序重排，未排过的排在后面', async () => {
    const { store } = createFakeStore([
      role('没排过但最新', null, NOW + 5000),
      role('第三', 2),
      role('第一', 0),
      role('第二', 1),
    ]);
    const service = new RoleService(store);

    await service.load();

    expect(service.list().map((item) => item.name)).toEqual([
      '第一',
      '第二',
      '第三',
      '没排过但最新',
    ]);
  });

  it('已有手动序时，新建角色在最前 —— 刷新后依然', async () => {
    const { store } = createFakeStore([role('甲', 0), role('乙', 1)]);
    const service = new RoleService(store);
    await service.load();

    const created = await service.create({ name: '丙' });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.sortOrder).toBe(-1);
    expect(service.list()[0]?.name).toBe('丙');

    // 重新装载 = 刷新
    await service.load();
    expect(service.list()[0]?.name).toBe('丙');
  });

  it('从没手动排过时不写多余编号', async () => {
    const { store } = createFakeStore([role('甲', null)]);
    const service = new RoleService(store);
    await service.load();

    const created = await service.create({ name: '乙' });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.sortOrder).toBeNull();
  });

  it('复制不继承来源编号（否则两行同号，落位只能靠兜底规则）', async () => {
    const source = role('甲', 5);
    const { store } = createFakeStore([source, role('乙', 7)]);
    const service = new RoleService(store);
    await service.load();

    const clone = await service.duplicate(source.id);

    expect(clone.ok).toBe(true);
    if (!clone.ok || !clone.data) return;
    // min(5, 7) - 1 = 4：排在来源之前，而不是跟它同号
    expect(clone.data.sortOrder).toBe(4);
  });

  it('导入不沿用文件里的编号，按本地现有编号重新落位', async () => {
    const { store } = createFakeStore([role('甲', 0)]);
    const service = new RoleService(store);
    await service.load();

    const exported = service.exportToJson(service.list()[0]!.id);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const imported = await service.importFromJson(exported.data);

    expect(imported.ok).toBe(true);
    if (!imported.ok || !imported.data) return;
    expect(imported.data.sortOrder).toBe(-1);
    expect(service.list()[0]?.id).toBe(imported.data.id);
  });
});
