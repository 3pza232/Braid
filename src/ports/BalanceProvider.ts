import type { BalanceSnapshot } from '@domain/value-objects/billing';
import type { Result } from '@shared/result';

/**
 * 余额探测端口
 *
 * 实现方负责"跑用户脚本 + 发请求 + 解析响应"这三件事，
 * 因此余额接口**没有任何厂商假设**：一切由用户的脚本决定。
 */
export interface BalanceProvider {
  probe(script: string, context: BalanceProbeContext): Promise<Result<BalanceSnapshot>>;
}

export interface BalanceProbeContext {
  /** 当前 API Key（用于替换脚本里的 {{apiKey}}） */
  apiKey: string;
  /** 当前端点（用于替换脚本里的 {{baseUrl}}） */
  baseUrl: string;
  timeoutMs: number;
}
