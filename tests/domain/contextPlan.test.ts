import { describe, expect, it } from 'vitest';
import { describeContextActions, planContext } from '@domain/rules/contextPlan';
import type { TranscriptMessage } from '@domain/rules/toolTranscript';
import { estimateTokens } from '@domain/value-objects/usage';
import { asId } from '../helpers/messageNode';

/**
 * 发送前的体积处理（压缩的收尾环节）
 *
 * 它现在只做两件事，都必须守住同一条底线：**不改对话内容**。
 *  - 压过长的工具输出（工具的原始返回动辄上万字，模型只需要知道大概）；
 *  - 仍然超限就如实上报，绝不做"偷偷截断正文"这种事。
 *
 * 历史上这里还有一档"丢弃最早的历史"，已被**压缩**取代 ——
 * 丢历史等价于让模型失忆，而省下的 token 与压缩差不多。
 */

const text = (role: TranscriptMessage['role'], content: string): TranscriptMessage => ({
  role,
  content,
});

const toolResult = (callId: string, content: string): TranscriptMessage => ({
  role: 'tool',
  content,
  toolCallId: asId(callId) as never,
});

const assistantWithTool = (callId: string): TranscriptMessage => ({
  role: 'assistant',
  content: '我查一下',
  toolCalls: [{ id: asId(callId) as never, name: 'read_file', argumentsJson: '{"path":"a"}' }],
});

describe('装得下时一个字节都不改', () => {
  it('低于预算原样返回', () => {
    const messages = [text('system', '你是助手'), text('user', '你好')];
    const result = planContext({ messages, budget: 10_000 });

    expect(result.messages).toEqual(messages);
    expect(result.actions).toEqual([{ kind: 'none' }]);
  });

  it('预算未知（<= 0）时不干预，也不误报超限', () => {
    // 没有预算信息就什么都不做，比"按一个猜出来的预算乱压"安全得多
    const messages = [text('user', '很长的一段话'.repeat(200))];
    const result = planContext({ messages, budget: 0 });

    expect(result.messages).toEqual(messages);
    expect(result.actions).toEqual([{ kind: 'none' }]);
  });
});

describe('压缩过长的工具输出', () => {
  it('压成头 + 尾，并明确告诉模型可以重调工具', () => {
    const huge = 'x'.repeat(5000);
    const messages = [assistantWithTool('c1'), toolResult('c1', huge)];
    const result = planContext({ messages, budget: 200 });

    const trimmed = result.messages[1];
    expect(trimmed.content.length).toBeLessThan(huge.length);
    expect(trimmed.content.startsWith('x'.repeat(400))).toBe(true);
    expect(trimmed.content).toContain('省略');
    // 给省略号会让模型以为内容本身残缺，进而重复调用工具 —— 必须说清"可以重调"
    expect(trimmed.content).toContain('重新调用');
    expect(result.actions[0]).toMatchObject({ kind: 'trim-tool-results', count: 1 });
  });

  it('不长的工具结果不动它', () => {
    const messages = [assistantWithTool('c1'), toolResult('c1', '短内容')];
    expect(planContext({ messages, budget: 100_000 }).messages[1].content).toBe('短内容');
  });

  it('对话正文与工具调用参数一个字都不动', () => {
    // 只压工具**结果**：正文是用户与模型的话，参数是模型的意图，都不能替它改
    const messages = [
      text('user', '很长的问题'.repeat(200)),
      assistantWithTool('c1'),
      toolResult('c1', 'y'.repeat(5000)),
    ];
    const result = planContext({ messages, budget: 10 });

    expect(result.messages[0].content).toBe('很长的问题'.repeat(200));
    expect(result.messages[1].toolCalls?.[0].argumentsJson).toBe('{"path":"a"}');
  });

  it('压完就装下时不再报告超限', () => {
    const messages = [
      text('system', 's'),
      text('user', '第一个问题'),
      assistantWithTool('c1'),
      toolResult('c1', 'y'.repeat(5000)),
    ];
    const result = planContext({ messages, budget: 400 });

    expect(result.actions.some((action) => action.kind === 'over-budget')).toBe(false);
    expect(result.usedTokens).toBeLessThanOrEqual(400);
  });
});

describe('无能为力时如实上报', () => {
  it('报告超出多少，正文一个字都不截', () => {
    const long = '无论怎么压都放不下'.repeat(50);
    const result = planContext({ messages: [text('user', long)], budget: 10 });

    expect(result.actions).toContainEqual({ kind: 'over-budget', overBy: expect.any(Number) });
    expect(result.messages[0].content).toBe(long);
  });

  it('usedTokens 是**压过之后**的值（界面据此显示还有多少空间）', () => {
    const messages = [assistantWithTool('c1'), toolResult('c1', 'z'.repeat(5000))];
    const result = planContext({ messages, budget: 200 });
    const raw = estimateTokens('z'.repeat(5000));

    expect(result.usedTokens).toBeLessThan(raw);
  });
});

describe('describeContextActions（给用户看的一句话）', () => {
  it('什么都没做时返回 null —— 界面据此完全不打扰用户', () => {
    expect(describeContextActions([{ kind: 'none' }])).toBeNull();
  });

  it('压了工具输出就说清压了几条、省了多少', () => {
    const note = describeContextActions([{ kind: 'trim-tool-results', count: 3, savedTokens: 1200 }]);
    expect(note).toContain('3 条');
    expect(note).toContain('1200');
  });

  it('超预算时给出可判断的信息，而不是"出错了"', () => {
    const note = describeContextActions([{ kind: 'over-budget', overBy: 500 }]);
    expect(note).toContain('500');
    expect(note).toContain('上限');
  });

  it('多个动作合成一句话', () => {
    const note = describeContextActions([
      { kind: 'trim-tool-results', count: 1, savedTokens: 100 },
      { kind: 'over-budget', overBy: 200 },
    ]);
    expect(note).toContain('；');
  });
});
