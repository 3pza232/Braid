/**
 * 由列清单生成 UPSERT 语句
 *
 * 【为什么单独一个文件】
 * 它有两类调用方：
 *  1. 各仓储的列常量（`rows.ts` / `messageRows.ts` / `conversationRows.ts`）；
 *  2. **门禁脚本** `scripts/check-sql.mjs` —— 它要拿"与运行时完全相同"的算法
 *     生成一遍语句，交给 SQLite 编译，验证列数与占位符数对得上。
 *
 * 第 2 类调用方决定了这个文件必须**零依赖**（不能有任何 `@domain/...` 别名导入）：
 * 脚本是普通 Node ESM，靠类型擦除直接加载 `.ts`，解析不了打包器的别名。
 *
 * 早先脚本里抄了一份"保持同一算法"的副本 —— 那种约定没有东西守护：
 * 改了这边忘了那边，门禁会拿着旧算法给出一个**假绿灯**（比没有门禁更糟）。
 */
export function buildUpsert(
  table: string,
  columns: readonly string[],
  conflictColumn = 'id',
): string {
  return [
    `INSERT INTO ${table} (${columns.join(', ')})`,
    `VALUES (${columns.map(() => '?').join(', ')})`,
    `ON CONFLICT(${conflictColumn}) DO UPDATE SET`,
    columns
      .filter((column) => column !== conflictColumn)
      .map((column) => `  ${column} = excluded.${column}`)
      .join(',\n'),
  ].join('\n');
}
