import { nanoid } from 'nanoid';
import type { RolePreset } from '@domain/entities/rolePreset';
import {
  builtinRoles,
  createEmptyRole,
  deserializeRole,
  serializeRole,
} from '@domain/entities/rolePreset';
import { orderRoles, renumberByOrder, topOrderOf } from '@domain/rules/manualOrder';
import type { RoleStore } from '@ports/repositories/RoleStore';
import type { RoleApi } from '@ports/RoleApi';
import type { RoleId } from '@shared/ids';
import { asRoleId } from '@shared/ids';
import { ok, type Result } from '@shared/result';

/**
 * 角色服务（应用层）
 *
 * 职责：
 *  1. 首次启动时写入出厂样例角色（之后它们就是普通数据，可改可删）；
 *  2. 提供 CRUD、复制、导入导出；
 *  3. 维护订阅，让 UI 镜像最新列表。
 *
 * 注意：这里**没有任何"哪个角色更好"的判断**，也不限制字段取值。
 * 目标是给"喜欢极致定制化"的用户一个不带偏见的工具箱。
 */
export class RoleService implements RoleApi {
  private roles: RolePreset[] = [];
  private loaded = false;
  private readonly listeners = new Set<(roles: RolePreset[]) => void>();

  constructor(private readonly store: RoleStore) {}

  list(): RolePreset[] {
    return this.roles;
  }

  get(id: RoleId | null | undefined): RolePreset | null {
    if (!id) return null;
    return this.roles.find((role) => role.id === id) ?? null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<Result<RolePreset[]>> {
    const result = await this.store.getAll();
    if (!result.ok) return result;

    let roles = result.data;
    const seededResult = await this.store.hasSeeded();
    const seeded = seededResult.ok && seededResult.data;

    // 首次启动写入出厂样例。判定依据来自**存储自己**（见 RoleStore.hasSeeded 的注释），
    // 应用层不再需要知道数据是存在 localStorage 还是 SQLite。
    if (roles.length === 0 && !seeded) {
      roles = builtinRoles(Date.now());
      for (const role of roles) await this.store.save(role);
    }

    // 无论这次有没有写样例，都记下"已初始化"：
    // 这样用户把样例全删掉之后重启，不会被重新塞回来。
    if (!seeded) await this.store.markSeeded();

    this.roles = orderRoles(roles);
    this.loaded = true;
    this.emit();
    return ok(this.roles);
  }

  async create(init: Partial<RolePreset> = {}): Promise<Result<RolePreset>> {
    const now = Date.now();
    const role = createEmptyRole(asRoleId(`role-${nanoid(8)}`), now, {
      // 新建的排在已手动排过的之前（否则刷新后它会掉到列表末尾）
      sortOrder: topOrderOf(this.roles),
      ...init,
    });
    const saved = await this.store.save(role);
    if (!saved.ok) return saved;

    this.roles = orderRoles([...this.roles, role]);
    this.emit();
    return ok(role);
  }

  async upsert(role: RolePreset): Promise<Result<RolePreset>> {
    const next: RolePreset = { ...role, updatedAt: Date.now() };
    const saved = await this.store.save(next);
    if (!saved.ok) return saved;

    const index = this.roles.findIndex((item) => item.id === role.id);
    this.roles = index >= 0 ? replaceAt(this.roles, index, next) : [...this.roles, next];
    this.roles = orderRoles(this.roles);
    this.emit();
    return ok(next);
  }

  async duplicate(id: RoleId): Promise<Result<RolePreset | null>> {
    const source = this.get(id);
    if (!source) return ok(null);

    const now = Date.now();
    const clone = createEmptyRole(asRoleId(`role-${nanoid(8)}`), now, {
      ...source,
      builtin: false,
      name: `${source.name} 副本`,
      createdAt: now,
      updatedAt: now,
      // 副本是"新的一项"：不该继承来源的编号（否则两行同号，排序只能靠兜底规则）
      sortOrder: topOrderOf(this.roles),
    });

    const saved = await this.store.save(clone);
    if (!saved.ok) return saved;

    this.roles = orderRoles([...this.roles, clone]);
    this.emit();
    return ok(clone);
  }

  async remove(id: RoleId): Promise<Result<void>> {
    const removed = await this.store.remove(id);
    if (!removed.ok) return removed;

    this.roles = this.roles.filter((role) => role.id !== id);
    this.emit();
    return ok(undefined);
  }

  async importFromJson(json: string): Promise<Result<RolePreset | null>> {
    const parsed = deserializeRole(json, asRoleId(`role-${nanoid(8)}`), Date.now());
    if (!parsed) {
      return ok(null);
    }
    /*
     * 编号按这台机器算，不沿用文件里的
     *
     * 导出文件带着来源机器的手动序编号，直接采用会和本地已有的编号撞车
     * （两行同号 → 顺序只能靠兜底规则，看起来就是"导入进来的角色位置很随机"）。
     */
    parsed.sortOrder = topOrderOf(this.roles);
    const saved = await this.store.save(parsed);
    if (!saved.ok) return saved;

    this.roles = orderRoles([...this.roles, parsed]);
    this.emit();
    return ok(parsed);
  }

  exportToJson(id: RoleId): Result<string> {
    const role = this.get(id);
    if (!role) return ok('');
    return ok(serializeRole(role));
  }

  subscribe(listener: (roles: RolePreset[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 手动排序
   *
   * 只给**传进来的那些 id** 重新编号：被过滤掉、没显示的那些保持不动 ——
   * 给看不见的东西重编号，等于用户每次拖动都在悄悄改动他没看到的东西。
   */
  async reorder(orderedIds: RoleId[]): Promise<Result<void>> {
    const next = renumberByOrder(this.roles, orderedIds);
    // 只落库真的变了的那几行（`renumberByOrder` 不替换未变的项，因此引用比较可靠）
    const changed = next.filter((role, index) => role !== this.roles[index]);

    // 一次事务写完：逐条写中途失败会留下"半个新顺序"（与会话排序同一个理由）
    if (changed.length > 0) {
      const saved = await this.store.saveMany(changed);
      if (!saved.ok) return saved;
    }

    this.roles = orderRoles(next);
    this.emit();
    return ok(undefined);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.roles);
  }
}

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  const next = [...list];
  next[index] = value;
  return next;
}


