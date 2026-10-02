import type { BalanceSnapshot } from '@domain/value-objects/billing';
import type { Result } from '@shared/result';

/**
 * 余额服务的对外契约
 *
 * 如果用户没写余额脚本，`get()` 返回 null，界面就不显示余额 ——
 * 而不是显示一个假的 ¥0.00。
 */
export interface BalanceApi {
  get(): BalanceSnapshot | null;
  isRefreshing(): boolean;
  /** 手动刷新（顶栏点击）；脚本为空时直接返回 null */
  /**
   * 刷新余额
   *
   * 返回的 `Result` 说的是"这次刷新跑没跑成"，**业务失败在快照里**（`snapshot.error`）：
   * 脚本跑通了、接口报错了，那是"拿到了结果，结果是失败" —— 所以这里不返回 `err`。
   * 界面读的是快照，别把 `ok()` 读成"余额没问题"。
   */
  refresh(): Promise<Result<BalanceSnapshot | null>>;
  subscribe(listener: (snapshot: BalanceSnapshot | null) => void): () => void;
  /** 请求中状态变化（用于转圈） */
  subscribeBusy(listener: (busy: boolean) => void): () => void;
}
