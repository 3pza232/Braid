import type { FinishReason, MessageSegment, MessageStatus } from '@domain/entities/message';
import { SAMPLING_CONSTRAINTS } from '@domain/value-objects/sampling';
import { FAILURE_MARK, appendFailure } from '@app/chat/messageAssembly';
import type { AppError } from '@shared/result';

/**
 * 定稿：这次生成**算成功、算失败、还是用户按了停止**
 *
 * 【为什么单独成模块】
 * 三条规则都容易被"顺手改坏"，而它们的后果都指向同一种难看：把错误写进正文。
 *  - **用户点「停止」不是错误**。中止时 provider 会抛一条 `ABORTED` 的 error 事件，
 *    它和其他失败一样落进 `failure`。照原样处理的话，用户主动停止会被存成
 *    `status: 'error'`，还会往正文里追一行「⚠️ 已停止生成」—— 明明是自己按的，
 *    看起来却像出了故障，而且那行字永久留在消息里再也去不掉；
 *  - **只出了思考、没有正文时要说明**。推理模型偶尔把整段回答写进思考、正文一个
 *    token 都不给（典型触发是思考占满了「单轮输出上限」）；此时界面是一个空气泡，
 *    用户只能怀疑"是不是卡住了"；
 *  - **判断"有没有正文"要连已定稿的段一起看**：续写与工具轮的正文在 `settled` 里，
 *    只看本轮累积的 `text` 会把"正常写了几轮"误判成"什么都没写"。
 *
 * 纯函数：给这一段输入，答案就定了 —— 与仓储、线程表、通知都无关，因此能单独测。
 */
export interface StreamOutcomeInput {
  /** 本轮累积的正文（还没固化进 `settled` 的那部分） */
  text: string;
  reasoning: string;
  /** 前面几轮留下的段（续写与工具轮的正文都在这里） */
  settled: readonly MessageSegment[];
  finishReason: FinishReason;
  failure: AppError | null;
  aborted: boolean;
}

export interface StreamOutcome {
  /** 定稿时写进消息的正文（失败说明会被追在里面） */
  body: string;
  status: MessageStatus;
  finishReason: FinishReason;
}

/*
 * 设置项的名字取自**同一处定义**（`SAMPLING_CONSTRAINTS.maxTokens.label`），不写死
 *
 * 这里最初写的是改名前的老名字「单次最大输出」，改名时漏了它 —— 于是用户看到的
 * 提示指着一个界面上已经不存在的选项（同一类漏改在工具提示词里也有过一处）。
 * 引用常量之后，"改个名要记得同步几处"这件事就不用靠记性了。
 */
const MAX_OUTPUT_LABEL = SAMPLING_CONSTRAINTS.maxTokens.label;

const ONLY_REASONING_NOTE =
  `${FAILURE_MARK} 本轮模型只输出了思考过程，没有输出正文` +
  `（常见原因是思考占满了「${MAX_OUTPUT_LABEL}」）。点「重新生成」，或把它调大一些再试。`;

export function classifyStreamOutcome(input: StreamOutcomeInput): StreamOutcome {
  const hasText =
    input.text.trim().length > 0 ||
    input.settled.some((segment) => segment.kind === 'text' && segment.text.trim().length > 0);
  const hasReasoning =
    input.reasoning.trim().length > 0 ||
    input.settled.some(
      (segment) => segment.kind === 'reasoning' && segment.text.trim().length > 0,
    );

  // 先认 ABORTED：中止既不是失败，也不该在正文里留下任何痕迹
  const aborted = input.aborted || input.failure?.code === 'ABORTED';
  const failure = aborted ? null : input.failure;

  const body = failure
    ? appendFailure(input.text, failure)
    : !hasText && hasReasoning
      ? ONLY_REASONING_NOTE
      : input.text;

  const status: MessageStatus = aborted ? 'aborted' : failure ? 'error' : 'complete';
  const finishReason: FinishReason = aborted ? 'aborted' : failure ? 'error' : input.finishReason;

  return { body, status, finishReason };
}
