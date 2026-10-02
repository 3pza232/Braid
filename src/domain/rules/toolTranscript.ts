import type { MessageRole, MessageSegment, ToolCall } from '@domain/entities/message';

/**
 * 把消息段重建成**发给模型的消息序列**
 *
 * 【为什么需要这一层】
 * 我们内部把一个"轮次"存成**一条消息 + 一串段**（`[text, tool_call, tool_result, text]`），
 * 因为这样界面能把它渲染成一个整体。但 OpenAI 兼容协议要的是**多条消息**：
 *
 * ```
 * { role: 'assistant', content: '我先看看目录', tool_calls: [c1, c2] }
 * { role: 'tool', tool_call_id: c1, content: '...' }
 * { role: 'tool', tool_call_id: c2, content: '...' }
 * { role: 'assistant', content: '已经写好了' }
 * ```
 *
 * 而协议有一条**硬性约束**：带 `tool_calls` 的 assistant 消息后面**必须紧跟**
 * 它对应的全部 `tool` 消息，不能插别的东西。一旦顺序错了，请求会被直接拒绝（HTTP 400），
 * 而且报文里看不太出原因。所以这个"分段重组"必须写对，且必须有测试钉住。
 *
 * 【为什么放在 domain】
 * 它是纯函数：段进、消息出，零依赖。放在这里就能用 Node 直接跑用例
 * （见 `tests/domain/toolTranscript.test.ts`），不用启动浏览器，也不用打包。
 */

/** 一条即将发送的消息（提供方无关的中间表示） */
export interface TranscriptMessage {
  role: MessageRole;
  content: string;
  /** 仅 assistant：本轮的并行工具调用 */
  toolCalls?: ToolCall[];
  /** 仅 role='tool'：对应的调用 id，必须与某个 tool_calls 的 id 一致 */
  toolCallId?: string;
}

/** 工具结果写给模型时的前缀：错误必须一眼可见，否则模型会把失败当成功继续编 */
const ERROR_PREFIX = '【失败】';

/**
 * 把一条消息的段追加到消息序列里
 *
 * 组装规则（顺序即正确性）：
 *  - 普通正文累积起来，遇到工具调用就"结算"成一条 assistant 消息；
 *  - 结算时把紧跟其后的工具结果按调用 id **配对**成 `role:'tool'` 消息；
 *  - `reasoning` / `summary` / `image` 段**不回放**：思考过程不构成对话内容，
 *    回放它既浪费 token 又会诱导模型模仿自己的思考格式。
 */
export function appendSegmentsToTranscript(
  out: TranscriptMessage[],
  role: MessageRole,
  segments: readonly MessageSegment[],
): void {
  let text = '';
  let calls: ToolCall[] = [];
  const results = new Map<string, MessageSegment & { kind: 'tool_result' }>();

  /** 结算一组工具调用：assistant(tool_calls) + 每个结果一条 tool 消息 */
  const settle = () => {
    if (calls.length === 0) return;
    out.push({ role: 'assistant', content: text, toolCalls: calls });
    for (const call of calls) {
      const result = results.get(call.id);
      /*
       * 找不到结果也要补一条：协议要求"每个 tool_call_id 都必须被回应"，
       * 缺一条整个请求就是非法的。这种情况真实存在 ——
       * 用户在中途点了停止，工具还没执行。
       */
      out.push({
        role: 'tool',
        toolCallId: call.id,
        content: result
          ? `${result.isError ? ERROR_PREFIX : ''}${result.content}`
          : '【未执行】用户中止了这一轮',
      });
    }
    text = '';
    calls = [];
    results.clear();
  };

  for (const segment of segments) {
    switch (segment.kind) {
      case 'text':
        // 结果已收齐后又出现正文 → 上一组到此为止，后面的正文属于下一轮
        if (results.size > 0) settle();
        text += segment.text;
        break;
      case 'tool_call':
        if (results.size > 0) settle();
        calls.push(segment.call);
        break;
      case 'tool_result':
        results.set(segment.callId, segment);
        break;
      case 'reasoning':
      case 'summary':
      case 'image':
        break;
    }
  }

  settle();

  // 收尾：还有正文、但没有未结算的调用 → 一条普通消息
  if (calls.length === 0 && text.length > 0) {
    out.push({ role, content: text });
  }
}
