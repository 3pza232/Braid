import type { SqlExecResult, SqlPort, SqlStatement, SqlValue } from '@ports/host/SqlPort';
import type { Result } from '@shared/result';

/**
 * 就绪门控装饰器
 *
 * 解决的问题：数据库的建表迁移是**异步**的，而界面是**立刻挂载**的
 * （为了首屏不被 WASM 加载拖慢）。于是可能出现"迁移还没跑完，
 * 某个仓储已经发起 SELECT"→ 打到不存在的表上。
 *
 * 做法：把迁移的 Promise 交给这个装饰器，之后**每一次**查询都先等它就绪。
 * 调用方完全无感 —— 不需要到处 `await ready`，也不会写出竞态。
 *
 * 注意：迁移本身必须使用**未门控**的原始端口，否则会自我等待造成死锁。
 */
export function createReadyGatedSqlPort(sql: SqlPort, ready: Promise<unknown>): SqlPort {
  const settled = ready.then(
    () => undefined,
    // 迁移失败也要放行：让后续查询自己报出真实错误，而不是永久挂起
    () => undefined,
  );

  return {
    get engine(): string {
      return sql.engine;
    },

    // 直接透传：门控只负责"等迁移就绪"，不改变引擎的持久化性质
    get durable(): boolean {
      return sql.durable;
    },

    async execute(sqlText: string, params?: SqlValue[]): Promise<Result<SqlExecResult>> {
      await settled;
      return sql.execute(sqlText, params);
    },

    async query<T>(sqlText: string, params?: SqlValue[]): Promise<Result<T[]>> {
      await settled;
      return sql.query<T>(sqlText, params);
    },

    async batch(statements: SqlStatement[]): Promise<Result<void>> {
      await settled;
      return sql.batch(statements);
    },

    close(): Promise<void> {
      return sql.close();
    },
  };
}
