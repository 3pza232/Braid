import type { MessageSegment, ToolCall } from '@domain/entities/message';

/** 一次工具执行的结果（与 `ToolRegistry.run` 的返回一致） */
export interface ExecutedTool {
  content: string;
  isError: boolean;
}

/**
 * 工具轮：固化本轮的段 → 执行调用 → 结果立刻上屏并落库
 *
 * 【为什么单独成模块】
 * 这段逻辑有三条**顺序与时机**上的规则，它们都不是"重构一下也无所谓"的细节：
 *
 *  1. **先固化，再执行**。顺序反了的话，用户在工具跑完之前看不到
 *     "模型要动我的文件了"，而写文件是**不可撤销**的动作 —— 必须先让它露头；
 *  2. **撞上轮数上限就整轮不动**（既不执行、也不固化）：不能让不可撤销的写操作
 *     在"最后一轮"悄悄跑掉，用户还没看见就落盘了；
 *  3. **用户中止后，剩下的调用不再执行**。消息序列会自动为它们补"未执行"，
 *     协议上仍然合法（见 `domain/rules/toolTranscript`）—— 不会留下一个悬空的调用。
 *
 * 另外：**每个结果都立刻上屏**。一个读文件、跑脚本的调用可能要几秒，
 * 让用户看着"卡住了"再一次性冒出来，和一个个出现，是完全不同的感受。
 *
 * 依赖是窄接口注入（与 `contextManager` 同一套路）：这样这段编排不需要
 * 知道会话 id、消息 id、时间戳从哪来，也就能被单独测。
 */
export interface ToolRoundDeps {
  /** 执行一个调用。**任何失败都要变成内容回来**（不抛）—— 工具报错是给模型看的 */
  run: (call: ToolCall) => Promise<ExecutedTool>;
  /** 把当前段落同步到界面（调用方负责发出变更通知） */
  show: (settled: readonly MessageSegment[]) => void;
  /** 把这条消息落库（可以不等待，但每固化一次都要落） */
  persist: () => void;
  /** 用户是否已经中止 */
  aborted: () => boolean;
}

export interface ToolRoundInput {
  calls: readonly ToolCall[];
  /** 本轮已经产出、尚未固化的内容 */
  reasoning: string;
  text: string;
  /** 已定稿的段。**原地追加**：调用方持有同一个数组，工具轮只往后接 */
  settled: MessageSegment[];
  /** 这一轮是否已经用满工具轮上限 */
  atRoundLimit: boolean;
}

export type ToolRoundOutcome =
  /** 撞上限：什么都没做，调用方负责告诉用户"还能再要一轮" */
  | { kind: 'round-limit' }
  | {
      kind: 'settled';
      /** 用户是否在工具执行期间中止（调用方据此决定不再发起新请求） */
      aborted: boolean;
      /** 真的执行了几个 */
      executed: number;
    };

export async function runToolRound(
  input: ToolRoundInput,
  deps: ToolRoundDeps,
): Promise<ToolRoundOutcome> {
  // 上限先判：连固化都不做（说明了见文件头第 2 条）
  if (input.atRoundLimit) return { kind: 'round-limit' };

  // 本轮产出按**发生顺序**固化：思考 → 正文 → 调用。顺序即事实
  if (input.reasoning.length > 0) input.settled.push({ kind: 'reasoning', text: input.reasoning });
  if (input.text.length > 0) input.settled.push({ kind: 'text', text: input.text });
  for (const call of input.calls) input.settled.push({ kind: 'tool_call', call });
  deps.show(input.settled);

  let executed = 0;
  for (const call of input.calls) {
    if (deps.aborted()) break;

    const result = await deps.run(call);
    input.settled.push({
      kind: 'tool_result',
      callId: call.id,
      name: call.name,
      content: result.content,
      isError: result.isError,
    });
    deps.show(input.settled);
    deps.persist();
    executed += 1;
  }

  return { kind: 'settled', aborted: deps.aborted(), executed };
}
