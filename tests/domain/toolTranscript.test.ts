import { describe, expect, it } from 'vitest';
import { appendSegmentsToTranscript, type TranscriptMessage } from '@domain/rules/toolTranscript';
import type { MessageSegment, ToolCall } from '@domain/entities/message';

const call = (id: string, name = 'write_file', path = 'a.txt'): ToolCall => ({
  id: id as never,
  name,
  argumentsJson: JSON.stringify({ path, content: 'x' }),
  parsed: { path, content: 'x' },
});
const text = (value: string): MessageSegment => ({ kind: 'text', text: value });
const reasoning = (value: string): MessageSegment => ({ kind: 'reasoning', text: value });
const callSeg = (c: ToolCall): MessageSegment => ({ kind: 'tool_call', call: c });
const resultSeg = (c: ToolCall, content: string, isError = false): MessageSegment => ({
  kind: 'tool_result',
  callId: c.id,
  name: c.name,
  content,
  isError,
});

function build(role: 'user' | 'assistant', segments: MessageSegment[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  appendSegmentsToTranscript(out, role, segments);
  return out;
}

/** 协议合法性：每个 tool 消息都对应紧邻其前的 assistant 调用，且声明必有回应 */
function validateProtocol(messages: TranscriptMessage[]): string | null {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    // 向前穿过连续的 tool 消息找归属（并行调用时前面会有一串 tool 消息）
    let cursor = index - 1;
    let matched = false;
    while (cursor >= 0 && messages[cursor].role === 'tool') {
      if (messages[cursor].toolCallId === message.toolCallId) matched = true;
      cursor -= 1;
    }
    if (
      cursor >= 0 &&
      messages[cursor].role === 'assistant' &&
      messages[cursor].toolCalls?.some((item) => item.id === message.toolCallId)
    ) {
      matched = true;
    }
    if (!matched) {
      return `第 ${index} 条 tool 消息（${message.toolCallId}）找不到对应的 assistant 调用`;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    // 向后收集连续的 tool 消息（并行调用会有多条），声明的每个 id 都必须被回应
    const responses: string[] = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      responses.push(messages[cursor].toolCallId ?? '');
      cursor += 1;
    }
    for (const declared of message.toolCalls) {
      if (!responses.includes(declared.id)) {
        return `assistant 声明的调用 ${declared.id} 没有被回应`;
      }
    }
  }
  return null;
}

const shape = (messages: TranscriptMessage[]): string =>
  messages
    .map((message) =>
      message.role === 'tool'
        ? `tool(${message.toolCallId})`
        : message.toolCalls
          ? `assistant[${message.toolCalls.map((item) => item.id).join(',')}]`
          : `${message.role}("${message.content}")`,
    )
    .join(' | ');

describe('工具往来的消息重建', () => {
  it('纯文本消息原样透传', () => {
    expect(shape(build('user', [text('你好')]))).toBe('user("你好")');
    expect(shape(build('assistant', [text('你好呀')]))).toBe('assistant("你好呀")');
  });

  it('思考段不回放', () => {
    expect(shape(build('assistant', [reasoning('让我想想'), text('答案')]))).toBe('assistant("答案")');
  });

  it('空消息不产生条目', () => {
    expect(build('assistant', [text(''), reasoning('只有思考')])).toHaveLength(0);
  });

  it('一次调用：assistant(tool_calls) 紧跟 tool 结果', () => {
    const c1 = call('c1');
    const messages = build('assistant', [text('我先看看'), callSeg(c1), resultSeg(c1, '3 项')]);
    expect(shape(messages)).toBe('assistant[c1] | tool(c1)');
    expect(validateProtocol(messages)).toBeNull();
  });

  it('并行调用按声明顺序回应', () => {
    const c2 = call('c2', 'read_file', 'b.txt');
    const c3 = call('c3', 'write_file', 'c.txt');
    const messages = build('assistant', [
      callSeg(c2),
      callSeg(c3),
      resultSeg(c2, 'r2'),
      resultSeg(c3, 'r3'),
    ]);
    expect(shape(messages)).toBe('assistant[c2,c3] | tool(c2) | tool(c3)');
    expect(validateProtocol(messages)).toBeNull();
  });

  it('多轮工具：正文被切分到各自的 assistant 消息', () => {
    const c1 = call('c1');
    const c2 = call('c2');
    const messages = build('assistant', [
      text('第一轮'),
      callSeg(c1),
      resultSeg(c1, 'r1'),
      text('第二轮'),
      callSeg(c2),
      resultSeg(c2, 'r2'),
      text('总结'),
    ]);
    expect(shape(messages)).toBe(
      'assistant[c1] | tool(c1) | assistant[c2] | tool(c2) | assistant("总结")',
    );
    expect(validateProtocol(messages)).toBeNull();
  });

  it('失败结果带【失败】前缀：模型不能把失败当成功', () => {
    const c1 = call('c1');
    const messages = build('assistant', [callSeg(c1), resultSeg(c1, '无权限编辑文件', true)]);
    expect(messages[1].content).toBe('【失败】无权限编辑文件');
  });

  it('被中止的调用也要补一条回应（协议要求每个 id 都被回应）', () => {
    const c1 = call('c1');
    const messages = build('assistant', [callSeg(c1)]);
    expect(messages[1].content).toContain('未执行');
    expect(validateProtocol(messages)).toBeNull();
  });

  it('混合历史整体合法', () => {
    const c1 = call('c1');
    const c2 = call('c2', 'write_file', 'b.txt');
    const c3 = call('c3', 'write_file', 'c.txt');
    const messages = [
      ...build('user', [text('帮我写两个文件')]),
      ...build('assistant', [
        text('好，先看看目录'),
        callSeg(c1),
        resultSeg(c1, '（空目录）'),
        text('我来创建'),
        callSeg(c2),
        callSeg(c3),
        resultSeg(c2, '已写入 b.txt'),
        resultSeg(c3, '已写入 c.txt'),
        text('写好了'),
      ]),
    ];
    expect(validateProtocol(messages)).toBeNull();
  });
});
