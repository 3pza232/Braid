import type { Conversation } from '@domain/entities/conversation';

/**
 * 上下文压缩产生的摘要
 *
 * 【它解决的是什么】
 * 上下文满了以后有两条路：把最早的历史**丢掉**（信息直接没了），
 * 或者把它**改写成摘要**（信息还在，只是变短）。后者就是压缩（compaction），
 * 也是现在各家 Agent harness 的通行做法 —— 丢掉的对话，模型再也想不起来；
 * 压过的对话，细节模糊但主线还在。
 *
 * 【为什么没有任何"丢弃"档位了】
 * 丢历史在体验上等价于"模型突然失忆"，而它省下的 token 与压缩差不多。
 * 既然要做，就只做信息保留的那一种。
 *
 * 【存在哪里：conversation.extensions.contextSummaries】
 * 摘要跟着会话走：与对话同生命周期、随会话一起删除、只在装配**这个**会话的
 * 请求时被读取，不参与任何跨会话查询。放进 extensions 而不是新建一张表，
 * 是为了不引入一个只被读取一次的端口 + 适配器 + join。
 * 将来真要做"跨会话检索历史"时再升级成表，届时这些数据可以原样搬运。
 *
 * 【为什么是列表而不是一条】
 * 反复压缩后，"新摘要 = 旧摘要 + 新覆盖的原文"再压一遍，信息会逐次收敛。
 * 保留历史既便于排查（"它到底把什么给压没了"），也让界面能显示压缩轨迹。
 */
export interface ContextSummary {
  id: string;
  /** 压缩时用的模型：换模型后摘要的文风与详略都会变，值得留档 */
  modelRef: string;
  /** 摘要正文 */
  text: string;
  /** 估算 token 数（界面用它显示"压掉了多少"） */
  tokens: number;
  /** 这次压缩覆盖了多少条原文 */
  coveredCount: number;
  createdAt: number;
}

const KEY = 'contextSummaries';

/** 摘要列表的上限：留着是为了排查与展示，但没必要无限增长 */
export const MAX_SUMMARIES = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * 严格校验并补全
 *
 * `extensions` 的内容来自磁盘上的 JSON —— 可能被手改过、被旧版本写坏过、
 * 甚至是别的程序写进去的。所以逐字段验，而不是 `as ContextSummary`：
 * 一个 undefined 的 `text` 会让界面渲染出空白，而那时已经离源头很远了。
 * 缺的可选字段（token 数之类）给安全默认值，缺的**必需**字段则整条丢弃。
 */
function toSummary(value: unknown): ContextSummary | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  if (typeof candidate.id !== 'string' || typeof candidate.createdAt !== 'number') return null;
  if (typeof candidate.text !== 'string' || candidate.text.length === 0) return null;
  return {
    id: candidate.id,
    modelRef: typeof candidate.modelRef === 'string' ? candidate.modelRef : '',
    text: candidate.text,
    tokens: typeof candidate.tokens === 'number' ? candidate.tokens : 0,
    coveredCount: typeof candidate.coveredCount === 'number' ? candidate.coveredCount : 0,
    createdAt: candidate.createdAt,
  };
}

/** 会话里全部摘要（按生成顺序） */
export function summariesOf(conversation: Conversation | null): ContextSummary[] {
  const raw = conversation?.extensions?.[KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map(toSummary).filter((item): item is ContextSummary => item !== null);
}

/**
 * 当前**生效**的那一条（最后生成的一条）
 *
 * 它才是装配请求时被插进去的那段文字。之前的摘要已经并入它，
 * 所以只认最后一条 —— 否则同一段历史会被重复叙述。
 */
export function activeSummaryOf(conversation: Conversation | null): ContextSummary | null {
  const all = summariesOf(conversation);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** 追加一条摘要，返回新的 `extensions`（调用方把它 patch 回会话） */
export function withSummary(
  conversation: Conversation,
  summary: ContextSummary,
): Record<string, unknown> {
  const next = [...summariesOf(conversation), summary];
  return {
    ...(conversation.extensions ?? {}),
    [KEY]: next.slice(-MAX_SUMMARIES),
  };
}


