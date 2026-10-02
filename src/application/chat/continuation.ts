import type { FinishReason } from '@domain/entities/message';

/**
 * 续写判定：这一轮完了，该收尾还是再来一轮？
 *
 * 【为什么把它单独拿出来】
 * 它原先埋在 `ChatService.runStream` 的轮循环里（那个函数三百多行，混合了
 * 请求组装、流消费、刷新与落库时机、工具轮、收尾）。而这几条判断是**规则**：
 * 与 provider、与界面、与数据库都无关，只跟"写了多少、模型怎么结束的、转了几轮"有关。
 *
 * 抽出来有两个好处：规则可以被用例逐条钉住（它们以前只活在几十行的缩进里），
 * 以及 `runStream` 少一块需要"读懂全部上下文才能改"的逻辑。
 *
 * 【判定的顺序是有讲究的，别随手重排】
 *  - 没开启续写 → 收；
 *  - 字数已到下限（而且模型是自然结束的）→ 完成；
 *  - 到了软上限 → 宁可少一点也收（为凑字数跑飞更糟）；
 *  - 结束原因不是 `stop` / `length`（内容过滤、错误…）→ 收：强行续只会越写越乱；
 *  - 连续多轮没有新增内容（原地打转）→ 收；
 *  - 轮数上限 → 收，但要告诉用户"是撞上限停的"，不是写完了。
 *
 * 停顿判定放在轮数上限**之前**：两者同时成立时，报"撞上限"会误导用户
 *（他以为还能再要几轮，其实是模型在打转）。
 */
export type ContinuationStopReason =
  /** 这个会话没开续写（普通对话） */
  | 'not-active'
  /** 写到字数下限了（正常完成） */
  | 'reached-target'
  /** 到了软上限：不再为凑字数继续 */
  | 'soft-max'
  /** 模型这轮不是自然结束（内容过滤 / 出错） */
  | 'unfinished'
  /** 连续几轮没产出新内容：在打转 */
  | 'stalled'
  /** 撞上续写轮数上限 */
  | 'round-limit';

export type ContinuationDecision =
  | { kind: 'continue' }
  | { kind: 'stop'; reason: ContinuationStopReason };

export interface ContinuationInput {
  /** 这个会话是否开了续写 */
  active: boolean;
  /** 目前累计的正文长度（字符） */
  chars: number;
  /** 字数下限（写够就算完成） */
  targetChars: number;
  /** 软上限（到这儿就收，不再凑字数） */
  softMaxChars: number;
  /** 本轮的结束原因；`null` = provider 没给 */
  finishReason: FinishReason | null;
  /** 连续多少轮没有新增内容（**含本轮**，调用方已推进） */
  stallCount: number;
  stallLimit: number;
  /** 已经续写了几轮 */
  rounds: number;
  maxRounds: number;
}

export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  if (!input.active) return { kind: 'stop', reason: 'not-active' };
  if (input.chars >= input.targetChars) return { kind: 'stop', reason: 'reached-target' };
  if (input.chars >= input.softMaxChars) return { kind: 'stop', reason: 'soft-max' };

  if (input.finishReason !== 'stop' && input.finishReason !== 'length') {
    return { kind: 'stop', reason: 'unfinished' };
  }

  if (input.stallCount >= input.stallLimit) return { kind: 'stop', reason: 'stalled' };
  if (input.rounds >= input.maxRounds) return { kind: 'stop', reason: 'round-limit' };

  return { kind: 'continue' };
}
