import { describe, expect, it } from 'vitest';
import { runToolRound, type ToolRoundDeps } from '@app/chat/toolRound';
import type { MessageSegment, ToolCall } from '@domain/entities/message';
import { kinds, runConversation } from '../helpers/chatHarness';

/**
 * 工具轮：固化 → 执行 → 结果上屏
 *
 * 这一段编排里有三条**顺序与时机**上的规则，它们都不是"重构一下也无所谓"的细节：
 *  1. 先固化再执行（先让用户看到"模型要动我的文件了"，写文件不可撤销）；
 *  2. 撞上轮数上限整轮不动（不能让不可撤销的写操作在最后一轮悄悄跑掉）；
 *  3. 用户中止后剩下的调用不再执行（协议上由消息装配补"未执行"）。
 * 前两条已被静默改坏过一次的风险很高（看起来只是把两行换下位置），所以逐条钉住。
 */
const call = (id: string): ToolCall => ({ id, name: 'read_file', argumentsJson: '{}' }) as ToolCall;

function harness(options: { abortAfter?: number; fail?: boolean } = {}) {
  const log: string[] = [];
  const settled: MessageSegment[] = [];
  let executed = 0;
  let aborted = false;

  const deps: ToolRoundDeps = {
    run: async (item) => {
      log.push(`run:${item.id}`);
      executed += 1;
      // "执行完第 N 个之后用户按了停止"
      if (options.abortAfter !== undefined && executed === options.abortAfter) aborted = true;
      return options.fail
        ? { content: `失败：${item.id}`, isError: true }
        : { content: `${item.id} 的结果`, isError: false };
    },
    show: () => log.push('show'),
    persist: () => log.push('persist'),
    aborted: () => aborted,
  };

  return { log, settled, deps, count: () => executed };
}

const base = { reasoning: '', text: '', atRoundLimit: false };

describe('runToolRound 的编排规则', () => {
  it('先固化再执行：第一次上屏发生在**任何**工具开跑之前', async () => {
    const { log, settled, deps } = harness();

    await runToolRound({ ...base, calls: [call('c1')], settled, text: '我先看一下' }, deps);

    expect(log[0]).toBe('show');
    expect(log.indexOf('run:c1')).toBeGreaterThan(0);
  });

  it('本轮产出按发生顺序固化：思考 → 正文 → 调用', async () => {
    const { settled, deps } = harness();

    await runToolRound(
      { ...base, reasoning: '想一下', text: '读它', calls: [call('c1'), call('c2')], settled },
      deps,
    );

    expect(settled.map((segment) => segment.kind)).toEqual([
      'reasoning',
      'text',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
    ]);
  });

  it('空内容不产生空段（界面上会变成一条空白）', async () => {
    const { settled, deps } = harness();

    await runToolRound({ ...base, calls: [call('c1')], settled }, deps);

    expect(settled.map((segment) => segment.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('每个结果**立刻**上屏并落库（工具可能要跑几秒，不该一次性冒出来）', async () => {
    const { log, settled, deps } = harness();

    await runToolRound({ ...base, calls: [call('c1'), call('c2')], settled }, deps);

    expect(log).toEqual(['show', 'run:c1', 'show', 'persist', 'run:c2', 'show', 'persist']);
  });

  it('结果内容（含"这是错误"）原样进段 —— 工具报错是给模型看的', async () => {
    const { settled, deps } = harness({ fail: true });

    await runToolRound({ ...base, calls: [call('c1')], settled }, deps);

    expect(settled[1]).toMatchObject({
      kind: 'tool_result',
      callId: 'c1',
      content: '失败：c1',
      isError: true,
    });
  });

  it('撞上轮数上限：**一个都不执行、也不固化**，由调用方去告诉用户"还能再要"', async () => {
    const { log, settled, deps, count } = harness();

    const outcome = await runToolRound(
      { ...base, calls: [call('c1'), call('c2')], settled, atRoundLimit: true },
      deps,
    );

    expect(outcome).toEqual({ kind: 'round-limit' });
    expect(count()).toBe(0);
    expect(settled).toEqual([]);
    expect(log).toEqual([]);
  });

  it('中止后剩下的调用不再执行：已跑的留下结果，没跑的连结果都不补', async () => {
    const { settled, deps, count } = harness({ abortAfter: 1 });

    const outcome = await runToolRound(
      { ...base, calls: [call('c1'), call('c2'), call('c3')], settled },
      deps,
    );

    expect(count()).toBe(1);
    expect(outcome).toEqual({ kind: 'settled', aborted: true, executed: 1 });
    expect(settled.filter((segment) => segment.kind === 'tool_result')).toHaveLength(1);
  });

  it('没中止时如实报告执行了几个（调用方不必自己数）', async () => {
    const { settled, deps } = harness();

    const outcome = await runToolRound({ ...base, calls: [call('c1'), call('c2')], settled }, deps);

    expect(outcome).toEqual({ kind: 'settled', aborted: false, executed: 2 });
  });
});

/* ────────────── 端到端：真跑一位模型 + 真工具 ────────────── */

describe('工具轮（端到端）', () => {
  const readCall = (id: string) => ({
    kind: 'tool_call' as const,
    call: { id, name: 'read_file', argumentsJson: JSON.stringify({ path: 'a.md' }) } as never,
  });

  it('多轮工具调用：每轮各走一次请求，结果都进**后续**请求，最后收在同一气泡里', async () => {
    const { node, requests } = await runConversation({
      prompt: '看看这些文件',
      rounds: [
        [readCall('call-1'), { kind: 'done', finishReason: 'tool_calls' as never }],
        [readCall('call-2'), { kind: 'done', finishReason: 'tool_calls' as never }],
        [
          { kind: 'delta', text: '都看完了' },
          { kind: 'done', finishReason: 'stop' as never },
        ],
      ],
    });

    // 两轮工具 + 一次收尾 = 三次请求
    expect(requests.length).toBe(3);
    expect(textOfNode(node)).toContain('都看完了');
    expect(kinds(node)).toBe('tool_call,tool_result,tool_call,tool_result,text');

    // 第二次调用的结果必须出现在**第三次**请求里，否则模型是在盲答
    const results = (node?.segments ?? [])
      .filter((segment): segment is MessageSegment & { kind: 'tool_result' } => segment.kind === 'tool_result')
      .map((segment) => segment.content);
    expect(results).toHaveLength(2);
    const third = JSON.stringify(requests[2]?.messages ?? []);
    for (const content of results) {
      expect(third).toContain(content.slice(0, 16));
    }
  });

  it('工具执行期间用户按停止：不再发起新请求，也不给没跑的调用补结果', async () => {
    const { node, requests } = await runConversation({
      prompt: '看看文件',
      rounds: [
        [readCall('call-1'), { kind: 'done', finishReason: 'tool_calls' as never }],
        [
          { kind: 'delta', text: '不该走到这里' },
          { kind: 'done', finishReason: 'stop' as never },
        ],
      ],
      // 一看到工具调用上屏就按停止 —— 此刻工具还没执行，事件是同步发出的，不用计时器
      beforeSend: (service) => {
        service.subscribe(() => {
          const snapshot = service.snapshot();
          const streaming = snapshot.tree.nodes.find(
            (item) => item.id === snapshot.streamingMessageId,
          );
          if (streaming?.segments.some((segment) => segment.kind === 'tool_call')) service.stop();
        });
      },
    });

    // 只发了一次请求：停止之后不该再白跑一趟往返
    expect(requests.length).toBe(1);
    // 没有正文就不留空段：否则界面上会多出一个空的彩色气泡
    expect(kinds(node)).toBe('tool_call');
    expect(textOfNode(node)).toBe('');
    expect(node?.status).toBe('aborted');
    // 工具调用还在（既成事实），只是没有对应的结果
    expect(node?.segments.filter((segment) => segment.kind === 'tool_result')).toHaveLength(0);
  });
});

/** 与夹具的 `textOf` 同样的取值，只是这里拿到的是 `MessageNode | null` */
function textOfNode(node: { segments: MessageSegment[] } | null): string {
  return (node?.segments ?? [])
    .map((segment) => (segment.kind === 'text' ? segment.text : ''))
    .join('');
}
