import type { RolePreset } from '@domain/entities/rolePreset';
import type { SqlPort } from '@ports/host/SqlPort';
import type { RoleStore } from '@ports/repositories/RoleStore';
import type { RoleId } from '@shared/ids';
import { ok, type Result } from '@shared/result';
import { ROLE_UPSERT_SQL, roleFromRow, roleParams, type SqlRow } from './rows';

const SEED_SCOPE = 'role';
const SEED_KEY = 'seeded';

/**
 * 基于 SQLite 的角色存储
 *
 * 与 localStorage 版的关键差异：
 *  - **按行增删改**，不是每次全量覆盖整个集合；
 *  - 出厂样例的"是否初始化过"标记存在 `repo_meta` 表里，
 *    因此清空角色 ≠ 重置标记（用户删光样例后不会被塞回来）。
 *
 * 本文件只做"SQL ↔ 实体"的搬运，不含任何业务判断（排序、样例内容都不在这里）。
 */
export function createSqliteRoleStore(sql: SqlPort): RoleStore {
  return {
    async getAll(): Promise<Result<RolePreset[]>> {
      const result = await sql.query<SqlRow>(
        'SELECT * FROM role_preset ORDER BY updated_at DESC',
      );
      if (!result.ok) return result;
      return ok(result.data.map(roleFromRow));
    },

    async save(role: RolePreset): Promise<Result<void>> {
      const result = await sql.execute(ROLE_UPSERT_SQL, roleParams(role));
      if (!result.ok) return result;
      return ok(undefined);
    },

    async saveMany(roles: readonly RolePreset[]): Promise<Result<void>> {
      if (roles.length === 0) return ok(undefined);
      // 一个事务：排序调整要么整体生效，要么完全不动
      return sql.batch(roles.map((role) => ({ sql: ROLE_UPSERT_SQL, params: roleParams(role) })));
    },

    async remove(id: RoleId): Promise<Result<void>> {
      const result = await sql.execute('DELETE FROM role_preset WHERE id = ?', [id]);
      if (!result.ok) return result;
      return ok(undefined);
    },

    async hasSeeded(): Promise<Result<boolean>> {
      const result = await sql.query<SqlRow>(
        'SELECT 1 AS present FROM repo_meta WHERE scope = ? AND key = ? LIMIT 1',
        [SEED_SCOPE, SEED_KEY],
      );
      if (!result.ok) return result;
      return ok(result.data.length > 0);
    },

    async markSeeded(): Promise<Result<void>> {
      const result = await sql.execute(
        `INSERT INTO repo_meta (scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SEED_SCOPE, SEED_KEY, String(Date.now())],
      );
      if (!result.ok) return result;
      return ok(undefined);
    },
  };
}
