import type { Result } from '@shared/result';

/** SQL 能接受的取值（与 wa-sqlite 的 SQLiteCompatibleType 对齐，去掉用不到的分支） */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * 执行结果
 *
 * 只回 `rowsAffected`：本项目的主键全是 TEXT（nanoid），
 * 因此不需要自增 rowid，也就避免了对引擎特有 API 的依赖。
 */
export interface SqlExecResult {
  rowsAffected: number;
}

/**
 * SQL 执行端口
 *
 * 设计取舍（有意偏离常见写法）：
 * 一般会写成 `transaction(fn: (tx) => Promise<T>)`，但数据库跑在 Worker 里，
 * 回调无法跨线程执行。因此改成 **`batch(statements)`**：
 * 把一批语句交给宿主在同一个事务里顺序执行，任一条失败整体回滚。
 *
 * 好处：接口更小（只有三个方法）、天然可跨线程、语义确定；
 * 代价：事务内不能根据上一条查询结果动态决定下一条语句 ——
 * 我们的写操作都是"已知语句序列"，不需要这种能力。
 *
 * 注意：`migrate` 不在端口上，而是作为 `runMigrations(sqlPort, migrations)` 的
 * 组合函数实现（见 adapters/storage/sqlite/runMigrations.ts）——
 * 迁移逻辑是"用三个原语拼出来的"，没必要变成每个引擎都要重新实现的接口方法。
 */
export interface SqlPort {
  /** 引擎标识，用于诊断与界面展示 */
  readonly engine: string;
  /**
   * 数据是否真的会落盘
   *
   * `false` = 引擎降级到内存实现，**关掉页面数据就没了**。
   * 界面必须据此给出醒目提示：让用户在开始写之前就知道，
   * 而不是第二天打开才发现昨天写的东西不见了。
   */
  readonly durable: boolean;
  execute(sql: string, params?: SqlValue[]): Promise<Result<SqlExecResult>>;
  query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<Result<T[]>>;
  batch(statements: SqlStatement[]): Promise<Result<void>>;
  /** 关闭连接（退出前调用；失败不阻断退出） */
  close(): Promise<void>;
}

/** 一条迁移：版本号必须严格递增 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * 存储初始化结果
 *
 * 放在 ports 层是因为**两端都要用它**：启动流程要产出它，设置页要展示它。
 * 若定义在 bootstrap 层，表现层引用就会越层。
 */
export interface StorageStatus {
  ready: boolean;
  /** 引擎与持久化方式，例如 `sqlite · OPFS (AccessHandlePoolVFS)` */
  engine: string;
  /**
   * 数据是否真的会落盘
   *
   * `false` = 引擎降级到内存实现，**关掉页面数据就没了**。
   * 界面据此给出醒目提示：让用户在开始写之前就知道，
   * 而不是第二天打开才发现昨天写的东西不见了。
   */
  durable: boolean;
  /** 浏览器是否已把本站存储标记为「持久」（授予后不会被自动清理） */
  grantedPersist: boolean;
  /**
   * 本次启动的 origin
   *
   * 存在的意义很具体：**换端口 = 换存储空间**。
   * `localhost:5173` 与 `localhost:5174` 在浏览器眼里是两个不同的站点，
   * 数据互不可见 —— 这是"昨天还好好的，今天全没了"最常见的原因之一。
   */
  origin: string;
  /**
   * 检测到"以前跑过，但这次数据库是新建的"
   *
   * 判据：localStorage 里有运行标记，但本次又执行了迁移
   * （已有库重启时迁移列表是空的）。出现它就意味着**数据被清掉了**，
   * 界面必须明说，否则用户只能自己猜。
   */
  recreated: boolean;
  /** 当前数据库结构版本（0 = 尚未建表） */
  schemaVersion: number;
  /** 本次启动实际应用了哪些迁移 */
  applied: string[];
  error: string | null;
  /**
   * 各表当前记录数
   *
   * 存在的意义是**让用户能自己确认"数据真的进库了"**：
   * 改一个设置 → 刷新 → 计数不变、内容还在，比任何说明都直观。
   */
  counts: { roles: number; settings: number };
}
