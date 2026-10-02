import type { SqlExecResult, SqlPort, SqlStatement, SqlValue } from '@ports/host/SqlPort';
import { appError, err, ok, type Result } from '@shared/result';

/**
 * Worker → 主线程的消息
 *
 * 两种形状：**响应**（带 `id`，与某次调用配对）与**诊断上报**（不带 `id`）。
 * 后者是 Worker 主动说的一句话，不属于任何一次调用 —— 见下面消息处理处的说明。
 */
type WorkerResponse =
  | { id: number; ok: boolean; data?: unknown; error?: string; engine?: string; durable?: boolean }
  | { warning: string };

/**
 * 主线程侧的 SqlPort 实现：把调用转发给 Worker
 *
 * 协议极简 —— `{ id, kind, ... }` 请求 / `{ id, ok, data }` 响应。
 * 用自增 id 做请求匹配，因此可以并发发起多个查询而不会串。
 * Worker 本身首次调用时才初始化（懒加载），所以创建容器不需要是异步的。
 */
export function createWaSqlitePort(): SqlPort {
  const worker = new Worker(new URL('./sqliteWorker.ts', import.meta.url), {
    type: 'module',
    name: 'braid-sqlite',
  });

  let nextId = 1;
  let engineName = 'sqlite（初始化中）';
  let durable = false;
  let closed = false;

  const pending = new Map<
    number,
    { resolve: (value: Result<unknown>) => void }
  >();

  worker.addEventListener('message', (event: MessageEvent) => {
    const response = event.data as WorkerResponse;

    /*
     * 诊断上报（不带 `id`）
     *
     * 早先这里会带着 `undefined` 一路走到 `pending.get(undefined)` 被静默丢掉 ——
     * 而那条上报说的正是"OPFS 不可用、数据不落盘"，是最该被看到的一句。
     * 它不属于任何一次调用，所以单独一支处理，不参与请求配对。
     */
    if ('warning' in response) {
      console.warn(`[sqlite] ${response.warning}`);
      return;
    }

    if (response.engine) engineName = response.engine;
    if (typeof response.durable === 'boolean') durable = response.durable;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);

    if (response.ok) {
      waiter.resolve(ok(response.data));
    } else {
      waiter.resolve(
        err(appError('STORAGE_ERROR', '本地数据操作失败', { detail: response.error })),
      );
    }
  });

  // Worker 崩溃时不要把调用方吊死
  worker.addEventListener('error', (event: ErrorEvent) => {
    const message = event.message || 'SQLite Worker 异常退出';
    for (const waiter of pending.values()) {
      waiter.resolve(err(appError('STORAGE_ERROR', message)));
    }
    pending.clear();
  });

  function send(request: Record<string, unknown>): Promise<Result<unknown>> {
    if (closed) {
      return Promise.resolve(err(appError('STORAGE_ERROR', '数据库连接已关闭')));
    }
    const id = nextId++;
    return new Promise<Result<unknown>>((resolve) => {
      pending.set(id, { resolve });
      worker.postMessage({ ...request, id });
    });
  }

  return {
    get engine() {
      return engineName;
    },

    get durable() {
      return durable;
    },

    execute(sql: string, params: SqlValue[] = []): Promise<Result<SqlExecResult>> {
      return send({ kind: 'execute', sql, params }) as Promise<Result<SqlExecResult>>;
    },

    query<T>(sql: string, params: SqlValue[] = []): Promise<Result<T[]>> {
      return send({ kind: 'query', sql, params }) as Promise<Result<T[]>>;
    },

    batch(statements: SqlStatement[]): Promise<Result<void>> {
      return send({ kind: 'batch', statements }) as Promise<Result<void>>;
    },

    async close(): Promise<void> {
      closed = true;
      worker.terminate();
    },
  };
}
