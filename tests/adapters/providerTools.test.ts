import { beforeEach, describe, expect, it } from 'vitest';
import { createOpenAICompatProvider } from '@adapters/providers/openAICompatProvider';
import type { ChatStreamEvent, ProviderMessage, ProviderTool } from '@ports/LLMProvider';

let captured: Record<string, unknown> | null = null;

const chunk = (delta: unknown, finish?: string): string =>
  JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] });

function installFetch(frames: string[]): void {
  const body = `${frames.map((frame) => `data: ${frame}\n\n`).join('')}data: [DONE]\n\n`;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _url: string,
    init: { body: string },
  ) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const connection = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  envVarName: '',
  requestTimeoutMs: 5000,
  extraBodyJson: '',
};

const tools: ProviderTool[] = [
  {
    type: 'function',
    function: { name: 'write_file', description: '写文件', parameters: { type: 'object' } },
  },
];

async function collect(
  frames: string[],
  messages: ProviderMessage[] = [{ role: 'user', content: 'x' }],
  withTools?: ProviderTool[],
): Promise<ChatStreamEvent[]> {
  installFetch(frames);
  const provider = createOpenAICompatProvider();
  const events: ChatStreamEvent[] = [];
  for await (const event of provider.streamChat({
    ...connection,
    model: 'test-model',
    messages,
    params: {} as never,
    ...(withTools ? { tools: withTools } : {}),
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  captured = null;
});

describe('provider 的流式工具调用', () => {
  it('碎片按 index 拼接成完整调用（id/name 覆盖、arguments 追加）', async () => {
    const events = await collect([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: '{"pa' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt",' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] }),
      chunk({}, 'tool_calls'),
    ]);

    const calls = events.filter((event) => event.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    if (calls[0]?.kind !== 'tool_call') return;
    expect(calls[0].call.name).toBe('write_file');
    expect(calls[0].call.argumentsJson).toBe('{"path":"a.txt","content":"hi"}');
    expect(calls[0].call.parsed).toEqual({ path: 'a.txt', content: 'hi' });

    const done = events.find((event) => event.kind === 'done');
    expect(done?.kind === 'done' && done.finishReason).toBe('tool_calls');
  });

  it('并行调用按 index 排序，而不是按到达顺序', async () => {
    const events = await collect([
      chunk({
        tool_calls: [{ index: 1, id: 'c2', function: { name: 'read_file', arguments: '{}' } }],
      }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_dir', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    const names = events
      .filter((event) => event.kind === 'tool_call')
      .map((event) => (event.kind === 'tool_call' ? event.call.name : ''));
    expect(names).toEqual(['list_dir', 'read_file']);
  });

  it('缺函数名的残帧被丢弃（不执行"名字未知"的工具）', async () => {
    const events = await collect([
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    expect(events.filter((event) => event.kind === 'tool_call')).toHaveLength(0);
  });

  it('传了工具才发 tools 字段；没传就完全不发', async () => {
    await collect([chunk({}, 'stop')], undefined, tools);
    expect(Array.isArray(captured?.tools)).toBe(true);

    await collect([chunk({}, 'stop')]);
    expect(captured && !('tools' in captured)).toBe(true);
  });

  it('工具往来映射到线格式：arguments 必须是字符串、tool_call_id 必须带上', async () => {
    const call = { id: 'call_9', name: 'write_file', argumentsJson: '{"path":"b.txt"}' };
    await collect([chunk({}, 'stop')], [
      { role: 'user', content: '帮我写' },
      { role: 'assistant', content: '好的', toolCalls: [call as never] },
      { role: 'tool', content: '已写入 b.txt', toolCallId: 'call_9' },
    ]);

    const wire = captured?.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(wire[1].tool_calls)).toBe(true);
    const fn = (wire[1].tool_calls as Array<{ function: { arguments: unknown } }>)[0].function;
    expect(typeof fn.arguments).toBe('string');
    expect(wire[2].tool_call_id).toBe('call_9');
  });
});
