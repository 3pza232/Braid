import type { SqlPort } from '@ports/host/SqlPort';
import type { SettingStore } from '@ports/repositories/SettingStore';
import { ok, type Result } from '@shared/result';
import { parseJson, toJson, type SqlRow } from './rows';

/**
 * 基于 SQLite 的设置存储
 *
 * 契约与 localStorage 版完全一致（`SettingStore` 端口），
 * 因此 `SettingsService` 与全部 UI 代码零改动 —— 这就是端口隔离的收益。
 *
 * 注意：这里是**通用键值**存储，不认识 `app.settings` 这个具体 key。
 * 用什么 key、值怎么清洗（例如擦掉 API Key）属于应用层的业务规则。
 */
export function createSqliteSettingStore(sql: SqlPort): SettingStore {
  return {
    async get<T>(key: string): Promise<Result<T | null>> {
      const result = await sql.query<SqlRow>(
        'SELECT value_json FROM setting WHERE key = ? LIMIT 1',
        [key],
      );
      if (!result.ok) return result;
      const row = result.data[0];
      if (!row) return ok(null);
      return ok(parseJson<T | null>(row['value_json'], null));
    },

    async set(key: string, value: unknown): Promise<Result<void>> {
      const result = await sql.execute(
        `INSERT INTO setting (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        [key, toJson(value), Date.now()],
      );
      if (!result.ok) return result;
      return ok(undefined);
    },

    async remove(key: string): Promise<Result<void>> {
      const result = await sql.execute('DELETE FROM setting WHERE key = ?', [key]);
      if (!result.ok) return result;
      return ok(undefined);
    },

    async getAll(): Promise<Result<Record<string, unknown>>> {
      const result = await sql.query<SqlRow>('SELECT key, value_json FROM setting');
      if (!result.ok) return result;

      const out: Record<string, unknown> = {};
      for (const row of result.data) {
        const key = row['key'];
        if (typeof key !== 'string') continue;
        out[key] = parseJson<unknown>(row['value_json'], null);
      }
      return ok(out);
    },
  };
}
