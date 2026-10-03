/** token 用量（值对象） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** 命中前缀缓存的提示词 token 数 */
  cachedPromptTokens?: number;
  /**
   * `cachedPromptTokens` 的来源
   *
   * 'provider'  = 服务端上报（精确，DeepSeek 的 `prompt_cache_hit_tokens`、
   *               OpenAI 的 `prompt_tokens_details.cached_tokens`）；
   * 'estimated' = 本地按公共前缀估算。
   * 界面必须把两者**区分显示**，不能把估算值冒充成服务端数据。
   */
  cacheSource?: CacheKind;
  /**
   * 整份用量是**本地估算**的（服务商还没给）
   *
   * 流式期间拿不到准确值：按 OpenAI 兼容协议，usage 随**最后一个 chunk** 才发回，
   * 所以那段时间只能按字数先估一个，让用户看到数字在涨；
   * 每轮请求一结束就用准确值替换掉（见 `ChatService` 的 `estimateLiveUsage`）。
   *
   * 与 `cacheSource` 同一条纪律：**估算绝不能冒充服务端数据**，界面必须区分显示。
   */
  estimated?: boolean;
  totalTokens: number;
}

export type CacheKind = 'provider' | 'estimated';

/** 缓存命中统计 */
export interface CacheStats {
  hitTokens: number;
  missTokens: number;
  source: CacheKind;
}

/**
 * 从用量里取出缓存统计
 *
 * **字段缺失**时返回 null；**命中为 0** 时返回 0%。这两件事必须区分：
 *  - 缺失 = 这次没人告诉我们缓存情况（界面不显示，而不是假装 0%）；
 *  - 0    = 确实一次没命中（要显示 0%，因为用户需要知道"缓存没起作用"）。
 * 早期版本把两者都当成"不显示"，结果用户以为功能坏了。
 */
export function cacheStatsOf(usage: TokenUsage): CacheStats | null {
  const hit = usage.cachedPromptTokens;
  if (hit === undefined) return null;
  return {
    hitTokens: Math.max(0, hit),
    missTokens: Math.max(0, usage.promptTokens - Math.max(0, hit)),
    source: usage.cacheSource ?? 'provider',
  };
}

/** 命中率 0–1 */
export function cacheHitRate(stats: CacheStats): number {
  const total = stats.hitTokens + stats.missTokens;
  return total > 0 ? stats.hitTokens / total : 0;
}

/** 命中率的中文显示，例如 `78%` */
export function formatCacheHitRate(stats: CacheStats): string {
  return `${Math.round(cacheHitRate(stats) * 100)}%`;
}

/**
 * 只用本地估算拼一份用量（流式期间用，界面必须显示成 `≈`）
 *
 * 【为什么需要它】准确值要等这一轮请求结束才到（协议如此：usage 随最后一个 chunk 发回）。
 * 在那之前给界面一个"在涨"的数 —— 否则用户要盯着一个空白等到整个回答写完，
 * 看起来就像"没有统计"（真实反馈）。
 *
 * 【参数为什么是分开的】提示词那一部分**一轮之内不变**，只需在轮首算一次；
 * 每 120ms 的 flush 只需要重算"这一轮又吐了多少字"（小、便宜）。
 * 调用方据此避免每帧去扫一遍上万字的 prompt（见 `ChatService.estimateLiveUsage`）。
 */
export function estimateUsage(promptTokens: number, completionText: string): TokenUsage {
  const completionTokens = estimateTokens(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

/**
 * 两个字符串的公共前缀长度（按 UTF-16 码元计）
 *
 * 用循环逐字符比较而不是先求最短长度再 slice：前缀缓存的实际命中就是
 * "从头开始完全一致到哪一位"，逐位比较是它最直接的模型。
 */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * 按「与上一次请求的公共前缀」估算缓存命中
 *
 * 【为什么这个估算是靠谱的】
 * 主流前缀缓存（DeepSeek / OpenAI / Anthropic）都是**块级、前缀精确匹配**：
 * 服务端把 prompt 从头开始按固定块切分，与已缓存的块逐块比对，命中多少算多少。
 * 所以"这次 prompt 与上次 prompt 的公共前缀有多长"在结构上就是正确的预测器。
 *
 * 【为什么仍然只能叫估算】
 * 真实命中还受这些因素影响：块粒度（DeepSeek 为 64 token）、缓存 TTL（数分钟到数小时）、
 * 并发与分片。这些服务端才知道。因此结果必须标记为 `estimated`。
 *
 * **提高命中率的做法不在显示层，而在请求构造层**：
 * 系统提示词与历史消息必须**逐字节稳定**（不加时间戳、不重排、JSON 键序固定），
 * 且只追加不修改前缀 —— 前缀一旦改动，其后全部失效。
 */
export function estimateCacheStats(previousPrompt: string, currentPrompt: string): CacheStats {
  let end = commonPrefixLength(previousPrompt, currentPrompt);
  // 不要在代理对中间切断，否则会算出一个并不存在的半个字符
  if (end > 0 && end < currentPrompt.length) {
    const code = currentPrompt.charCodeAt(end);
    if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
  }

  const hitTokens = estimateTokens(currentPrompt.slice(0, end));
  const totalTokens = estimateTokens(currentPrompt);
  return {
    hitTokens,
    missTokens: Math.max(0, totalTokens - hitTokens),
    source: 'estimated',
  };
}

/**
 * 累加两轮的用量
 *
 * 一次工具循环会发起多轮请求，而界面上它只是**一条**消息 ——
 * 所以必须把各轮的用量加起来，否则显示的是"最后一轮用了多少"，
 * 在长工具链里会严重低估。缓存命中数一并相加（都是前缀命中，可加）。
 */
export function addUsage(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;

  const cached =
    a.cachedPromptTokens === undefined && b.cachedPromptTokens === undefined
      ? undefined
      : (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0);
  const reasoning =
    a.reasoningTokens === undefined && b.reasoningTokens === undefined
      ? undefined
      : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);

  // 只要有一段是估算的，整体就只能算估算 —— 不能用准确值把估算"洗白"（同 cacheSource）
  const estimated = a.estimated || b.estimated;

  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(estimated !== undefined ? { estimated } : {}),
    // 只要有一轮是估算的，整体就只能算估算 —— 不能用精确值把估算"洗白"
    ...(a.cacheSource === 'estimated' || b.cacheSource === 'estimated'
      ? { cacheSource: 'estimated' as const }
      : a.cacheSource
        ? { cacheSource: a.cacheSource }
        : {}),
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * 字符 ↔ token 换算
 *
 * 【重要】整个应用**只有这一个地方**定义换算系数：
 * 上下文预算、小说模式长度下限、成本预估都必须调用这里的函数，
 * 否则三处预算会互相打架。
 */
export const CHAR_TO_TOKEN_RATIO = {
  /** 汉字：1 字约 1.5 token，保守取 1.7 以免预算打满 */
  cjk: 1.7,
  /** 拉丁字符：约 4 字符 / token */
  latin: 0.25,
} as const;

export const isCjk = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // 中文标点
    (code >= 0xff00 && code <= 0xffef) // 全角字符
  );
};

/**
 * token 数量的紧凑显示
 *
 * 顶栏宽度有限，1,000,000 写成 `1M` 才放得下；同时保留 K/M 两种量级，
 * 让"已用 / 总"一眼可比（`12K / 1M`）。
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * 启发式 token 估算（精度层 L3）
 *
 * 用来做流式过程中的实时估算与无 tokenizer 时的兜底，
 * 精度约 ±15%，调用方必须把结果标记为"约"。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk * CHAR_TO_TOKEN_RATIO.cjk + other * CHAR_TO_TOKEN_RATIO.latin);
}


