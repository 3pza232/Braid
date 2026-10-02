import * as SQLite from 'wa-sqlite';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import wasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';
import { MemoryAsyncVFS } from 'wa-sqlite/src/examples/MemoryAsyncVFS.js';
import type { SqlStatement, SqlValue } from '@ports/host/SqlPort';

/**
 * SQLite Worker
 *
 * 为什么数据库跑在 Worker 里：
 *  - OPFS 的 `FileSystemSyncAccessHandle` 只能在 Worker 中使用；
 *  - 查询与写入不阻塞 UI 线程，长会话滚动不会被卡住。
 *
 * 用的是 wa-sqlite 的 **async 构建**（`wa-sqlite-async.wasm`）：
 * 它靠 Asyncify 处理跨 VFS 的异步调用，**不需要 COOP/COEP 响应头**，
 * 因此静态部署（浏览器、以及 Electron 桌面壳）都能直接用。
 */

/* ── SQLite C 常量（取自 sqlite3.h，值稳定） ── */
const SQLITE_OPEN_READWRITE = 0x0000_0002;
const SQLITE_OPEN_CREATE = 0x0000_0004;
const SQLITE_ROW = 100;

/** Worker 作用域（只声明用到的两个方法，避免与 DOM lib 冲突） */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}
const ctx = self as unknown as WorkerScope;

type Request =
  | { id: number; kind: 'execute'; sql: string; params: SqlValue[] }
  | { id: number; kind: 'query'; sql: string; params: SqlValue[] }
  | { id: number; kind: 'batch'; statements: SqlStatement[] };

type Response =
  | { id: number; ok: true; data?: unknown; engine?: string; durable?: boolean }
  | { id: number; ok: false; error: string };

type SqliteApi = ReturnType<typeof SQLite.Factory>;
/** vfs_register 接受的参数类型（官方 d.ts 未直接导出 SQLiteVFS 时也能用） */
type VfsArgument = Parameters<SqliteApi['vfs_register']>[0];

let api: SqliteApi | null = null;
let db = 0;
let engineName = 'sqlite';
/**
 * 数据是否真的会落盘
 *
 * 与 `engineName` 分开表达：名字是给人看的，这个是给程序判断的 ——
 * 降级到内存库时它必须是 `false`，界面才能**醒目地**告诉用户
 * "现在写的东西关掉就没了"，而不是让他事后才发现。
 */
let durable = false;
let ready: Promise<void> | null = null;

/** 把 wa-sqlite 的低层语句接口包装成"一次一个结果集"的执行 */
async function stepStatement(stmt: number): Promise<{ rows: unknown[][]; columns: string[] }> {
  const sqlite = api!;
  const columns = sqlite.column_names(stmt);
  const rows: unknown[][] = [];
  while ((await sqlite.step(stmt)) === SQLITE_ROW) {
    rows.push(await sqlite.row(stmt));
  }
  return { rows, columns };
}

async function openDatabase(): Promise<void> {
  const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  const sqlite = SQLite.Factory(module);
  api = sqlite;

  // 优先 OPFS 持久化；不可用时降级为内存库（数据不落盘，但应用仍可用）
  let vfsName: string;
  try {
    const pool = new AccessHandlePoolVFS('.braid');
    await pool.isReady;
    await sqlite.vfs_register(pool as unknown as VfsArgument, true);
    vfsName = pool.name;
    engineName = `sqlite · OPFS (${vfsName})`;
    durable = true;
  } catch (error) {
    const memory = new MemoryAsyncVFS();
    await sqlite.vfs_register(memory as unknown as VfsArgument, true);
    vfsName = memory.name;
    engineName = 'sqlite · 内存（OPFS 不可用，数据不持久）';
    /*
     * 降级时**上报一句**（不带 id，属于诊断通道）
     *
     * 这条值得留下来：它说的是"数据不会落盘"—— 用户重开页面发现记录全没了时，
     * 这是第一手线索。界面上的「关于」页也会显示 durable 状态，但排查时控制台更快。
     */
    ctx.postMessage({ warning: `OPFS 不可用，已降级到内存库（数据不会落盘）：${String(error)}` });
  }

  db = await sqlite.open_v2(
    'braid.sqlite3',
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
    vfsName,
  );
  // 外键约束：消息与会话的级联删除依赖它
  await sqlite.exec(db, 'PRAGMA foreign_keys = ON;');
}

function ensureReady(): Promise<void> {
  if (!ready) ready = openDatabase();
  return ready;
}

async function handle(request: Request): Promise<unknown> {
  await ensureReady();
  const sqlite = api!;

  if (request.kind === 'execute') {
    let affected = 0;
    for await (const stmt of sqlite.statements(db, request.sql)) {
      if (request.params.length > 0) await sqlite.bind_collection(stmt, request.params);
      await stepStatement(stmt);
      affected += await sqlite.changes(db);
    }
    return { rowsAffected: affected };
  }

  if (request.kind === 'query') {
    const out: Record<string, SqlValue>[] = [];
    for await (const stmt of sqlite.statements(db, request.sql)) {
      if (request.params.length > 0) await sqlite.bind_collection(stmt, request.params);
      const { rows, columns } = await stepStatement(stmt);
      for (const values of rows) {
        const row: Record<string, SqlValue> = {};
        columns.forEach((name, index) => {
          row[name] = (values[index] ?? null) as SqlValue;
        });
        out.push(row);
      }
    }
    return out;
  }

  // batch：一个事务里顺序执行，任一条失败则整体回滚
  await sqlite.exec(db, 'BEGIN');
  try {
    for (const statement of request.statements) {
      for await (const stmt of sqlite.statements(db, statement.sql)) {
        if (statement.params && statement.params.length > 0) {
          await sqlite.bind_collection(stmt, statement.params);
        }
        await stepStatement(stmt);
      }
    }
    await sqlite.exec(db, 'COMMIT');
    return undefined;
  } catch (error) {
    await sqlite.exec(db, 'ROLLBACK');
    throw error;
  }
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as Request;
  void handle(request)
    .then((data) => {
      const response: Response = {
        id: request.id,
        ok: true,
        data,
        engine: engineName,
        durable,
      };
      ctx.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: Response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(response);
    });
});
