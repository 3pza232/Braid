import type { MessageSegment } from '@domain/entities/message';
import { describeContextActions, planContext } from '@domain/rules/contextPlan';
import { appendSegmentsToTranscript } from '@domain/rules/toolTranscript';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { ChatRequest, ProviderMessage, ProviderTool } from '@ports/LLMProvider';

/**
 * 组装"这一轮要发出去什么"
 *
 * 【为什么把它从 `runStream` 里切出来】
 * `runStream` 原先一个人管五件事：请求组装、流消费、刷新与落库时机、工具轮、收尾。
 * 而"这一轮发什么"是**纯的**：给它历史、已定稿的段、轮次和连接信息，它给出请求体 ——
 * 与 provider、与界面、与数据库都无关。切出来之后有两个直接好处：
 *  - 里面几条"顺序不能反"的规则可以被用例逐条钉住（它们以前只活在几百行的缩进里）；
 *  - `runStream` 少一块"改之前得先读懂全部上下文"的逻辑。
 *
 * 【三条顺序上的讲究，别随手重排】
 *  1. **已完成的工具往来要先并进消息**：少了它，模型在第二轮里看不到自己刚才调过
 *     什么，就会重复调用同一个工具（表现为"AI 反复读同一个文件"，它自己毫无察觉）；
 *  2. **续写指令在预算计算之前入列**：否则算出来的预算与真实请求对不上（少算了这一条）；
 *  3. **工具字段在没有工具时完全不发**：个别网关会把空数组判成非法参数。
 *
 * 【关于"上下文降级"：它不丢历史】
 * `planContext` 只压**过长的工具输出**（压成头 + 尾），装不下时如实上报而不是
 * 偷偷截断正文 —— 丢历史那件事由压缩（把历史改写成纪要）承担，因为让模型失忆
 * 省下的 token 和压缩差不多，却丢掉了信息。
 */
export interface RoundRequestInput {
  /** 第一轮就定下来的对话历史（不含本轮的产出） */
  history: readonly ProviderMessage[];
  /** 已经收工的轮次留下的段：正文 + 工具调用 + 工具结果。顺序即事实，只追加不改写 */
  settled: readonly MessageSegment[];
  /** 第几轮（从 0 起）。>0 且开了续写时，才带续写指令 */
  round: number;
  continuationActive: boolean;
  /** 续写指令（会话 → 角色 → 全局当前，已解析） */
  continuationPrompt: string;
  /** 本轮实际使用的采样参数（续写模式下会把 max_tokens 换成档位里的那个） */
  params: SamplingParams;
  /** 本轮可用的工具声明；空数组 = 没有工具 */
  tools: readonly ProviderTool[];
  /** 上下文预算（超出即降级裁剪） */
  contextBudget: number;
  /** 连接与模型信息（来自**解析后**的配置：会话 → 角色 → 全局当前） */
  connection: Pick<
    ChatRequest,
    'baseUrl' | 'apiKey' | 'requestTimeoutMs' | 'extraBodyJson' | 'model'
  >;
  signal: AbortSignal;
}

export interface RoundPlan {
  /**
   * 组装好的请求：直接交给 `provider.streamChat`
   *
   * 里面的 `messages` 经过了 `planContext` —— 它**不会丢弃历史**（那是压缩的职责），
   * 只压过长的工具输出，并在实在装不下时如实上报（绝不偷偷截断正文）。
   */
  request: ChatRequest;
  /**
   * 这一轮对上下文做了什么
   *
   * `null` = 一个字节都没改 —— 绝大多数请求走的都是这条路径。
   * 有动作（压了工具输出 / 超出上限）才把说明送进快照，让用户在顶栏看到
   * "发出去的和他看到的不完全一样"，而不是靠猜。
   */
  contextNote: string | null;
  /**
   * 超出上下文预算多少 token（`0` = 没超，或没有预算信息）
   *
   * 给调用方一个**判断依据**：续写中途发现它大于 0 就不该把这一轮发出去
   *（那是拿一次可能被上游拒绝的请求去赌，赌输了错误文案会被追进正文）。
   * 预算 <= 0 表示"没有预算信息"，此时一律报 0 —— 不拿未知的预算去拦人。
   */
  overBudgetTokens: number;
}

export function buildRoundRequest(input: RoundRequestInput): RoundPlan {
  const messages: ProviderMessage[] = [...input.history];
  appendSegmentsToTranscript(messages, 'assistant', input.settled);

  if (input.round > 0 && input.continuationActive) {
    /*
     * 续写指令**只发进请求**
     *
     * 它不入库、不上屏：用户要的是"AI 在同一个气泡里接着往下写"的连续感，
     * 看见一条"继续上文，不要重复"夹在中间会瞬间出戏。
     * 因为每轮都从 `settled` 重新组装消息，这个指令不会越积越多。
     */
    messages.push({ role: 'user', content: input.continuationPrompt });
  }

  const planned = planContext({ messages, budget: input.contextBudget });

  return {
    request: {
      ...input.connection,
      messages: planned.messages,
      params: input.params,
      ...(input.tools.length > 0 ? { tools: [...input.tools] } : {}),
      signal: input.signal,
    },
    contextNote: describeContextActions(planned.actions),
    overBudgetTokens: planned.budget > 0 ? Math.max(0, planned.usedTokens - planned.budget) : 0,
  };
}
