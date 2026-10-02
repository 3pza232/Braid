// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyRole } from '@domain/entities/rolePreset';
import type { RolePreset } from '@domain/entities/rolePreset';
import type { RoleApi } from '@ports/RoleApi';
import { asRoleId } from '@shared/ids';
import { ok } from '@shared/result';
import { BraidProvider } from '@ui/BraidProvider';
import { RolesPanel } from '@ui/panels/RolesPanel';
import { useRolesStore } from '@ui/stores/rolesStore';
import { createFakeContainer, installBrowserStubs } from '../helpers/fakeContainer';

/**
 * 改了没保存就想切走时，不能把草稿默默丢掉
 *
 * 原来的行为是这样的：`selected` 一变，同步草稿的 effect 就把编辑区重置成已保存版本 ——
 * 用户刚打的半屏内容**无声消失**，没有任何提示、也拿不回来。
 *
 * 这里钉住三件事：切换被拦下（角色没换）、提示条出现、选择"放弃修改并切换"才真的切。
 */
const roles: RolePreset[] = [
  createEmptyRole(asRoleId('role-a'), 1, { name: '甲' }),
  createEmptyRole(asRoleId('role-b'), 1, { name: '乙' }),
];

function bindRoles(): void {
  // 只给渲染与交互路径上会用到的方法，其余留空壳（同 fakeContainer 的约定）
  const api = {
    list: () => roles,
    get: (id: string | null | undefined) => roles.find((role) => role.id === id) ?? null,
    isLoaded: () => true,
    subscribe: () => () => undefined,
    upsert: async (role: RolePreset) => ok(role),
  } as unknown as RoleApi;

  useRolesStore.getState().bind(api);
}

describe('角色面板：未保存的草稿', () => {
  beforeEach(() => {
    installBrowserStubs();
    bindRoles();
  });

  afterEach(cleanup);

  const mount = () =>
    render(
      <BraidProvider container={createFakeContainer()}>
        <RolesPanel />
      </BraidProvider>,
    );

  it('切换角色之前先问一句，选择放弃才真的切', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: '角色预设' });

    // 改一下名字，制造"未保存"的状态
    const nameInput = within(dialog).getByDisplayValue('甲');
    fireEvent.change(nameInput, { target: { value: '甲（改）' } });
    expect(within(dialog).getByDisplayValue('甲（改）')).toBeTruthy();

    // 点另一个角色：不该直接切走
    /*
     * `^乙`：列表里那个角色行的可访问名以角色名开头；
     * 拖动手柄也叫"…「乙」…"，用 `/乙/` 会同时命中两个
     */
    fireEvent.click(within(dialog).getByRole('button', { name: /^乙/ }));
    expect(within(dialog).getByText(/有未保存的修改/)).toBeTruthy();
    // 编辑区还是刚才那份草稿（没有偷偷重置）
    expect(within(dialog).getByDisplayValue('甲（改）')).toBeTruthy();

    // 明确选择"放弃修改并切换"，这才切过去
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃修改并切换' }));
    expect(within(dialog).queryByText(/有未保存的修改/)).toBeNull();
    expect(within(dialog).getByDisplayValue('乙')).toBeTruthy();
  });

  it('"留下继续编辑"把提示收起，草稿一字不动', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: '角色预设' });

    const nameInput = within(dialog).getByDisplayValue('甲');
    fireEvent.change(nameInput, { target: { value: '甲（改）' } });
    /*
     * `^乙`：列表里那个角色行的可访问名以角色名开头；
     * 拖动手柄也叫"…「乙」…"，用 `/乙/` 会同时命中两个
     */
    fireEvent.click(within(dialog).getByRole('button', { name: /^乙/ }));

    fireEvent.click(within(dialog).getByRole('button', { name: '留下继续编辑' }));

    expect(within(dialog).queryByText(/有未保存的修改/)).toBeNull();
    expect(within(dialog).getByDisplayValue('甲（改）')).toBeTruthy();
  });
});

/** 让 `vi` 被用到（保留统一的 afterEach 清理习惯） */
void vi;
