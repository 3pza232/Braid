/**
 * 余额
 *
 * 金额换算的方式（已确认）：
 *   对话开始前跑一次余额脚本 → 记下 A
 *   对话结束后（等待同步约 15 秒）再跑一次 → 记下 B
 *   B - A 就是这一轮花掉的钱
 *
 * 因此**不需要价格表**：单价由服务端自己算，我们只读差额。
 * 这也顺带解决了"不同模型单价不同、缓存命中打折"等一堆难以维护的配置。
 */

/** 一次余额探测的结果（由用户脚本产出，字段是"约定"而非"保证"） */
export interface BalanceSnapshot {
  isValid: boolean;
  /** 剩余额度；null = 脚本没给出来 */
  remaining: number | null;
  /** 货币，例如 CNY */
  unit: string;
  fetchedAt: number;
  /** 失败原因（面向用户的中文） */
  error?: string;
}

export const EMPTY_BALANCE: BalanceSnapshot = {
  isValid: false,
  remaining: null,
  unit: '',
  fetchedAt: 0,
};

/** 金额格式化：小额保留 4 位，否则 ¥0.00 什么都看不出来 */
export function formatMoney(amount: number, currency: string): string {
  const abs = Math.abs(amount);
  const digits = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${currency}${amount.toFixed(digits)}`;
}

/**
 * 余额脚本的默认模板
 *
 * 只是**可选的起点**：用户点「插入示例」才会写进设置，不点就永远是空的。
 * {{apiKey}} / {{baseUrl}} 会被自动替换，避免把密钥写死进脚本文本。
 */
export const BALANCE_SCRIPT_EXAMPLE = `({
  request: {
    url: 'https://api.deepseek.com/user/balance',
    method: 'GET',
    headers: {
      Authorization: 'Bearer {{apiKey}}',
      'User-Agent': 'braid/1.0',
    },
  },
  // response 是接口返回的 JSON；返回 { isValid, remaining, unit } 即可
  extractor: function (response) {
    var info = response.balance_infos && response.balance_infos[0];
    return {
      isValid: !response.error && response.is_available === true,
      remaining: info && info.total_balance ? parseFloat(info.total_balance) : null,
      unit: info && info.currency ? info.currency : '',
    };
  },
})`;

/** 从脚本返回的未知对象里安全地取出结果 */
export function normalizeBalanceResult(raw: unknown, now: number): BalanceSnapshot {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_BALANCE, fetchedAt: now, error: '脚本没有返回对象' };
  }
  const source = raw as Record<string, unknown>;
  const remaining =
    typeof source['remaining'] === 'number' && Number.isFinite(source['remaining'])
      ? source['remaining']
      : null;
  return {
    isValid: source['isValid'] === true,
    remaining,
    unit: typeof source['unit'] === 'string' ? source['unit'] : '',
    fetchedAt: now,
  };
}
