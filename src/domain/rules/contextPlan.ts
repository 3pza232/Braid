import type { TranscriptMessage } from './toolTranscript';
import { estimateTokens } from '@domain/value-objects/usage';

/**
 * 发送前的体积处理（上下文压缩的**收尾**环节）
 *
 * 这里只做两件事，都是"不改变对话内容"的：
 *  1. **压缩过长的工具输出** —— 工具返回动辄上万字（读一个文件、列一次目录），
 *     而模型往往只需要知道"结果大概是什么"；压成头 + 尾既省地方又保住线索；
 *  2. **如实报告仍然超限** —— 当我们已经无能为力时，明说，而不是偷偷截断正文。
 *
 * 【为什么不再有"丢弃最早的历史"】
 * 那件事现在由**压缩**（把历史改写成纪要）承担：丢历史等价于让模型失忆，
 * 省下的 token 却和压缩差不多。既然要做，就只做信息保留的那一种。
 * 所以这个模块的输入里已经没有"保留几轮"了 —— 那是压缩的职责。
 */

export type ContextAction =
  | { kind: 'none' }
  /** 过长的工具输出被压成「头 + 尾」 */
  | { kind: 'trim-tool-results'; count: number; savedTokens: number }
  /** 能压的都压完了仍然超预算：如实上报，绝不偷偷改对话内容 */
  | { kind: 'over-budget'; overBy: number };

export interface ContextPlan {
  /** 实际要发出去的消息 */
  messages: TranscriptMessage[];
  actions: ContextAction[];
  usedTokens: number;
  /** 可用预算（已扣掉输出预留）。<= 0 表示没有预算信息，此时不干预 */
  budget: number;
}

export interface ContextPlanInput {
  messages: readonly TranscriptMessage[];
  budget: number;
}

/** 单个工具结果保留的头 / 尾长度（字符） */
const TOOL_RESULT_HEAD = 400;
const TOOL_RESULT_TAIL = 200;
/** 低于这个长度就不值得压：压了省不下多少，反而丢内容 */
const TOOL_RESULT_MIN_LENGTH = TOOL_RESULT_HEAD + TOOL_RESULT_TAIL + 400;

function messageTokens(message: TranscriptMessage): number {
  let tokens = estimateTokens(message.content);
  for (const call of message.toolCalls ?? []) tokens += estimateTokens(call.argumentsJson);
  return tokens;
}

function sumTokens(messages: readonly TranscriptMessage[]): number {
  let sum = 0;
  for (const message of messages) sum += messageTokens(message);
  return sum;
}

/**
 * 把过长的工具结果压成「头 + 尾」
 *
 * 中间那段换成一句**给模型看的说明**，而不是省略号：
 * 模型看到省略号会以为内容本身就是残缺的，进而重复调用工具；
 * 明确告诉它"想看得更细就再调一次"，它才会做出正确选择。
 */
function condenseToolResult(message: TranscriptMessage): TranscriptMessage | null {
  if (message.role !== 'tool' || message.content.length < TOOL_RESULT_MIN_LENGTH) return null;
  const head = message.content.slice(0, TOOL_RESULT_HEAD);
  const tail = message.content.slice(-TOOL_RESULT_TAIL);
  const omitted = message.content.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return {
    ...message,
    content: `${head}\n…（此处省略 ${omitted} 个字符的工具输出，需要更细的内容请重新调用该工具）\n${tail}`,
  };
}

export function planContext(input: ContextPlanInput): ContextPlan {
  const original = input.messages;
  const total = sumTokens(original);

  // 装得下就一个字节都不改 —— 这是绝大多数请求走的路径
  if (input.budget <= 0 || total <= input.budget) {
    return { messages: [...original], actions: [{ kind: 'none' }], usedTokens: total, budget: input.budget };
  }

  const actions: ContextAction[] = [];

  // ── 压缩过长的工具输出 ──
  let trimmed = 0;
  const condensed = original.map((message) => {
    const next = condenseToolResult(message);
    if (next) trimmed += 1;
    return next ?? message;
  });

  let current = original as TranscriptMessage[];
  let used = total;

  if (trimmed > 0) {
    const condensedTokens = sumTokens(condensed);
    actions.push({
      kind: 'trim-tool-results',
      count: trimmed,
      savedTokens: used - condensedTokens,
    });
    current = condensed;
    used = condensedTokens;
  }

  // ── 仍然超限就如实报告 ──
  if (used > input.budget) {
    actions.push({ kind: 'over-budget', overBy: used - input.budget });
  }

  return { messages: current, actions, usedTokens: used, budget: input.budget };
}

/**
 * 把动作翻译成给用户看的一句话
 *
 * 返回 null 表示"什么都没做" —— 界面据此完全不打扰用户。
 * 有动作时要说清楚**做了什么**，而不是含糊的"已优化上下文"：
 * 用户需要据此判断"要不要开个新会话"。
 */
export function describeContextActions(actions: readonly ContextAction[]): string | null {
  const parts: string[] = [];
  for (const action of actions) {
    switch (action.kind) {
      case 'none':
        break;
      case 'trim-tool-results':
        parts.push(`压缩了 ${action.count} 条过长的工具输出（省下约 ${action.savedTokens} token）`);
        break;
      case 'over-budget':
        parts.push(`上下文超出设定上限约 ${action.overBy} token，可能被上游拒绝`);
        break;
    }
  }
  return parts.length > 0 ? parts.join('；') : null;
}
