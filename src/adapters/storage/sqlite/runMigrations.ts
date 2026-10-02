import type { Migration, SqlPort } from '@ports/host/SqlPort';
import { appError, err, ok, type Result } from '@shared/result';

const META_TABLE = `CREATE TABLE IF NOT EXISTS schema_migration (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

export interface MigrationReport {
  from: number;
  to: number;
  applied: string[];
}

/**
 * 迁移执行器
 *
 * 它是**组合函数而不是端口方法**：迁移逻辑完全由 execute/query/batch 三个原语拼出来，
 * 因此不需要每个引擎各实现一遍（Redis、内存等实现同样适用）。
 *
 * 事务边界：`schema_migration` 的登记与该迁移的语句放在**同一个 batch** 里，
 * 因此不会出现"表建好了但没记上版本"从而下次重复执行的中间态。
 */
export async function runMigrations(
  sql: SqlPort,
  migrations: readonly Migration[],
): Promise<Result<MigrationReport>> {
  const created = await sql.execute(META_TABLE);
  if (!created.ok) {
    return err(appError('STORAGE_MIGRATION_FAILED', '无法创建迁移记录表', { detail: created.error }));
  }

  const currentRows = await sql.query<{ version: number }>(
    'SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1',
  );
  if (!currentRows.ok) {
    return err(appError('STORAGE_MIGRATION_FAILED', '无法读取当前数据库版本', { detail: currentRows.error }));
  }

  const from = currentRows.data[0]?.version ?? 0;
  const pending = [...migrations].filter((m) => m.version > from).sort((a, b) => a.version - b.version);

  const applied: string[] = [];
  for (const migration of pending) {
    const result = await sql.batch([
      ...migration.statements.map((statement) => ({ sql: statement })),
      {
        sql: 'INSERT OR REPLACE INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)',
        params: [migration.version, migration.name, Date.now()],
      },
    ]);

    if (!result.ok) {
      return err(
        appError('STORAGE_MIGRATION_FAILED', `迁移 ${migration.version}_${migration.name} 执行失败`, {
          detail: result.error,
        }),
      );
    }
    applied.push(`${migration.version}_${migration.name}`);
  }

  const to = pending.length > 0 ? pending[pending.length - 1]!.version : from;
  return ok({ from, to, applied });
}
