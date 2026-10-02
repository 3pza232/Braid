/**
 * SQL 结构一致性检查
 *
 * 【为什么需要这个门禁】
 * 仓储的 UPSERT 语句、绑定参数数组、表结构是三份**必须逐字对齐**的东西：
 * 列名写错一个字母、迁移里加了列却忘了加进参数列表 —— TypeScript 完全看不见，
 * 只会在用户点「保存角色」的那一刻炸成运行时错误。这类 bug 试错成本极高。
 *
 * 这里用 Node 内置的 `node:sqlite` 在**内存库**里真跑一遍迁移，
 * 再把各表的 UPSERT 列清单与 `PRAGMA table_info` 对照，双向检查：
 *   - 列清单里有、表里没有 → 写一个不存在的列（必炸）
 *   - 表里有、列清单里没有 → 这一列永远写不进去（静默丢数据）
 *
 * 顺带用 `prepare()` 验证生成的 SQL 语法正确、占位符数量与列数一致。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/*
 * UPSERT 算法**不在这里抄一份**
 *
 * 直接加载运行时那一份（`adapters/storage/sqlite/upsert.ts`，零依赖所以能被
 * 普通 Node 的类型擦除直接读）。早先这里是"保持同一算法"的副本 ——
 * 那种约定没有东西守护：改了实现忘了改副本，门禁就会拿着旧算法给出假绿灯。
 */
const { buildUpsert } = await import(
  pathToFileURL(path.join(root, 'src/adapters/storage/sqlite/upsert.ts')).href
);

/* ── 各仓储「列清单常量 → 表名」的对应关系 ── */
const TARGETS = [
  { file: 'src/adapters/storage/sqlite/rows.ts', constant: 'ROLE_COLUMNS', table: 'role_preset' },
  {
    file: 'src/adapters/storage/sqlite/conversationRows.ts',
    constant: 'CONVERSATION_COLUMNS',
    table: 'conversation',
  },
  {
    file: 'src/adapters/storage/sqlite/messageRows.ts',
    constant: 'MESSAGE_COLUMNS',
    table: 'message',
  },
];

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /*
   * **不再静默跳过**
   *
   * 跳过还退出 0，会留下"已经检查过了"的假象；而这条门禁挡的是
   * "列清单与表结构错位"这类只在用户点保存的那一刻才炸的 bug ——
   * 它恰恰是最不该被悄悄跳过的一条。
   *
   * 确实需要在旧 Node 上本地验证时，用 BRAID_ALLOW_SKIP_SQL=1 **显式**表示
   * "我知道这次没检查"，而不是让所有人默认拿到一个虚假的绿灯。
   */
  if (process.env.BRAID_ALLOW_SKIP_SQL === '1') {
    console.log('[sql] ⚠ 当前 Node 不支持 node:sqlite（需 22.5+），按 BRAID_ALLOW_SKIP_SQL=1 显式跳过');
    process.exit(0);
  }
  console.error('[sql] ❌ 当前 Node 不支持 `node:sqlite`（需 22.5+），结构一致性检查无法执行');
  console.error('      升级 Node；或在知情的前提下设 BRAID_ALLOW_SKIP_SQL=1 跳过。');
  process.exit(1);
}

let migrations;
try {
  // 必须转成 file:// URL：Windows 下绝对路径不能直接交给 ESM 加载器
  ({ MIGRATIONS: migrations } = await import(
    pathToFileURL(path.join(root, 'src/adapters/storage/sqlite/migrations.ts')).href
  ));
} catch (error) {
  if (process.env.BRAID_ALLOW_SKIP_SQL === '1') {
    console.log('[sql] ⚠ 无法直接载入 TypeScript 迁移（需 Node 23.6+ 的类型擦除），按显式授权跳过');
    console.log(`      原因：${error.message}`);
    process.exit(0);
  }
  console.error('[sql] ❌ 无法直接载入 TypeScript 迁移（需 Node 23.6+ 的类型擦除）');
  console.error(`      原因：${error.message}`);
  console.error('      升级 Node；或在知情的前提下设 BRAID_ALLOW_SKIP_SQL=1 跳过。');
  process.exit(1);
}

const db = new DatabaseSync(':memory:');

// 真跑一遍迁移：DDL 有语法错误、索引引用了不存在的列，都会在这里直接暴露
for (const migration of migrations) {
  for (const statement of migration.statements) {
    try {
      db.exec(statement);
    } catch (error) {
      fail(`migrations v${migration.version} (${migration.name}) 执行失败：${error.message}`);
    }
  }
}

/** 断言失败即整体失败，但继续跑完剩下的检查，一次把问题都报出来 */
let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`  ❌ ${message}`);
}

for (const target of TARGETS) {
  const source = readFileSync(path.join(root, target.file), 'utf8');
  const columns = extractColumns(source, target.constant, target.file);

  const actual = db
    .prepare(`PRAGMA table_info(${target.table})`)
    .all()
    .map((row) => row.name);

  const declared = new Set(columns);
  const existing = new Set(actual);

  for (const column of columns) {
    if (!existing.has(column)) {
      fail(`${target.table}: 列清单里的 "${column}" 在表结构中不存在`);
    }
  }
  for (const column of actual) {
    if (!declared.has(column)) {
      fail(`${target.table}: 表结构里的 "${column}" 没有被任何写入语句覆盖（永远写不进去）`);
    }
  }

  // 用与运行时完全相同的算法生成 UPSERT，再交给 SQLite 编译一次
  const sql = buildUpsert(target.table, columns);
  try {
    db.prepare(sql);
    // 占位符数量必须与列数一致，否则运行时 "绑定参数个数不匹配"
    const placeholders = (sql.match(/\?/g) ?? []).length;
    if (placeholders !== columns.length) {
      fail(`${target.table}: 占位符 ${placeholders} 个，列 ${columns.length} 个`);
    }
  } catch (error) {
    fail(`${target.table}: UPSERT 语句无法编译 —— ${error.message}`);
  }

  console.log(`  ✓ ${target.table} (${columns.length} 列)`);
}

console.log(
  failures === 0
    ? '[sql] ✅ 迁移可执行，列清单与表结构一致'
    : `[sql] ❌ 发现 ${failures} 处问题`,
);
process.exitCode = failures === 0 ? 0 : 1;

/* ────────────────────────── 辅助 ────────────────────────── */

/** 从源码里抠出 `const NAME = [ 'a', 'b', ... ] as const;` 的字符串项 */
function extractColumns(source, constant, file) {
  const match = new RegExp(`const\\s+${constant}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) {
    fail(`${file}: 找不到 ${constant}`);
    return [];
  }
  const items = match[1].match(/'[^']+'|"[^"]+"/g) ?? [];
  return items.map((item) => item.slice(1, -1));
}


