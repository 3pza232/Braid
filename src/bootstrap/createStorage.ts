import { createWaSqlitePort } from '@adapters/host/waSqlitePort';
import { MIGRATIONS } from '@adapters/storage/sqlite/migrations';
import { runMigrations } from '@adapters/storage/sqlite/runMigrations';
import { toInt, type SqlRow } from '@adapters/storage/sqlite/rows';
import type { SqlPort, StorageStatus } from '@ports/host/SqlPort';

export interface StorageHandle {
  /** 已就绪门控的端口：交给仓储使用，它们不必关心迁移是否跑完 */
  readonly sql: SqlPort;
  /** 迁移与历史数据导入完成后 resolve，产出可供界面展示的状态 */
  readonly ready: Promise<StorageStatus>;
  /**
   * 重新统计各表记录数
   *
   * 为什么需要它：建表阶段统计出来的数字**还不包含**应用启动后才写入的数据
   * （例如角色服务种的出厂样例）。不重新统计的话，「关于」会显示"角色 0"，
   * 让用户误以为没落库 —— 一个会误导人的诊断信息比没有更糟。
   */
  recount(): Promise<StorageStatus>;
}

/**
 * 「这个 origin 上跑过」的标记
 *
 * 放在 localStorage 里是为了和数据库**分开**：数据库被清掉而标记还在，
 * 正是我们要识别的那个信号（见 detectRecreated）。
 */
const SEEN_MARKER = 'braid.storage.seen';

/**
 * 创建并初始化本地数据库
 *
 * 顺序：
 *   1. 打开引擎（Worker 懒初始化，此处不阻塞）
 *   2. 申请持久化存储（不申请的话浏览器可以随时清掉）
 *   3. 建表 / 迁移
 *   4. 统计记录数，产出状态
 *
 * 为什么把这些绑在一个 Promise 里：它们是**同一个前置条件** ——
 * "存储可用"的含义就是"表建好了"。用一个 Promise 表达，调用方只需等一次。
 */
export function createStorage(): StorageHandle {
  const sql = createWaSqlitePort();
  const ready = bootstrapDatabase(sql);

  return {
    sql,
    ready,
    async recount(): Promise<StorageStatus> {
      const status = await ready;
      return { ...status, counts: await countRows(sql) };
    },
  };
}

/**
 * 申请「持久化存储」
 *
 * 不申请的话，浏览器把本站当作 best-effort：**磁盘紧张时可以随时清掉它的数据**。
 * 申请成功后（Chrome 会按"是否安装为应用、访问频率、是否被收藏"等自行判断）
 * 数据不会被自动清理。返回值必须**如实展示** —— 批准与否不由我们决定，
 * 骗用户"已经安全了"比不提示更糟。
 */
async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * 识别"数据库是被新建出来的"
 *
 * 判据：**以前在这个 origin 上跑过**（localStorage 有标记），但本次启动又执行了迁移。
 * 已有库重启时 `applied` 是空的，所以这个组合只可能是"库没了、被重建了"。
 *
 * 这是应用内唯一能主动发现"数据被清掉"的办法。它覆盖不了"整个 origin 的数据
 * 一起被清"（那样连标记都没了），那种情况要靠持久化授权 + 界面上的 origin 提示。
 */
function detectRecreated(applied: readonly string[]): boolean {
  try {
    const seenBefore = localStorage.getItem(SEEN_MARKER) !== null;
    localStorage.setItem(SEEN_MARKER, String(Date.now()));
    return seenBefore && applied.length > 0;
  } catch {
    // localStorage 不可用（隐私模式等）：不能据此下结论，宁可不报
    return false;
  }
}

async function bootstrapDatabase(sql: SqlPort): Promise<StorageStatus> {
  const grantedPersist = await requestPersistence();
  const origin = typeof location === 'undefined' ? '' : location.origin;

  const migrated = await runMigrations(sql, MIGRATIONS);

  if (!migrated.ok) {
    return {
      ready: false,
      engine: sql.engine,
      durable: sql.durable,
      grantedPersist,
      origin,
      recreated: false,
      schemaVersion: 0,
      applied: [],
      error: migrated.error.message,
      counts: { roles: 0, settings: 0 },
    };
  }

  return {
    ready: true,
    engine: sql.engine,
    durable: sql.durable,
    grantedPersist,
    origin,
    recreated: detectRecreated(migrated.data.applied),
    schemaVersion: migrated.data.to,
    applied: migrated.data.applied,
    error: null,
    counts: await countRows(sql),
  };
}

async function countRows(sql: SqlPort): Promise<{ roles: number; settings: number }> {
  const roles = await sql.query<SqlRow>('SELECT COUNT(*) AS n FROM role_preset');
  const settings = await sql.query<SqlRow>('SELECT COUNT(*) AS n FROM setting');
  return {
    roles: roles.ok ? toInt(roles.data[0]?.['n']) : 0,
    settings: settings.ok ? toInt(settings.data[0]?.['n']) : 0,
  };
}
