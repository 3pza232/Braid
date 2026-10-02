import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createToolCall } from '@domain/entities/message';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { ChatStreamEvent, LLMProvider } from '@ports/LLMProvider';
import { ok } from '@shared/result';
import { createFakeProvider, createFakeWorkspace, createSettings, createStores } from '../helpers/chatHarness';

/**
 * ChatService 的**守卫与上限**
 *
 * 这些是"带副作用的编排"里最容易出错、也最难靠手点验证的部分：
 * 并发守卫到底拦没拦住、工具循环会不会跑飞。它们的共同点是
 * **一旦坏了就非常贵**（两条流同时写同一棵树 / 无限烧 token），
 * 所以用确定性的假 provider 把它们钉住。
 */

/** 一个可以被测试"卡住"的 provider：yield 一段内容后停在那里，直到放行 */
function createGatedProvider(): { provider: LLMProvider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const provider = {
    id: 'gated',
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { kind: 'delta', text: '半截内容' };
      await gate;
      yield { kind: 'done', finishReason: 'stop' as const };
    },
    complete: async () => ok({ text: '' }),
    probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
  } as unknown as LLMProvider;

  return { provider, release };
}

function createService(provider: LLMProvider) {
  const { store, messages } = createStores();
  const workspace = createFakeWorkspace();
  const settings = createSettings();

  return new ChatService(
    store,
    messages,
    settings,
    provider,
    createWorkspaceToolRegistry(workspace.api),
  );
}

describe('ChatService 的并发守卫', () => {
  it('上一条还在生成时，再发一条会被挡住', async () => {
    const { provider, release } = createGatedProvider();
    const service = createService(provider);
    await service.load();

    const first = await service.send('第一条');
    expect(first.ok).toBe(true);
    // 流被 provider 卡住：这条仍在生成中
    expect(service.snapshot().streamingMessageId).not.toBeNull();

    const second = await service.send('第二条');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('VALIDATION_ERROR');

    // 放行之后守卫必须**自动释放** —— 否则界面会永久卡在"上一条还在生成中"
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.snapshot().streamingMessageId).toBeNull();

    const third = await service.send('第三条');
    expect(third.ok).toBe(true);
  });
});

describe('工具循环的上限', () => {
  it('模型一直要求调工具时，轮数被 MAX_TOOL_ROUNDS 截断', async () => {
    // 10 轮，每轮都要求调一次工具：没有上限的话这里会无限循环。
    // 事件形状必须与端口一致（`tool_call` 是单数、一次一个；`done` 才决定这一轮怎么收尾）
    const rounds: ChatStreamEvent[][] = Array.from({ length: 10 }, () => [
      { kind: 'tool_call', call: createToolCall('c1', 'list_dir', '{}') },
      { kind: 'done', finishReason: 'tool_calls' },
    ]);

    const { provider, requests } = createFakeProvider(rounds);
    const service = createService(provider);
    await service.load();

    await service.send('列出目录');
    for (let waited = 0; waited < 200; waited += 1) {
      if (service.snapshot().streamingMessageId === null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // 8 是 ChatService 里的上限；只断言"没有跑满 10 轮"更能说明问题所在
    expect(requests.length).toBeLessThanOrEqual(8);
    expect(requests.length).toBeGreaterThan(1);
  });
});
