import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { ChatApi } from '@ports/ChatApi';
import type { LLMProvider } from '@ports/LLMProvider';
import { appError, err, ok } from '@shared/result';
import { useChatStore } from '@ui/stores/chatStore';
import { createFakeWorkspace, createSettings, createStores } from '../helpers/chatHarness';

/**
 * 发送要把**成败交回调用方**
 *
 * 输入区据此决定要不要清空草稿。早先 `send` 和别的命令一样走 `run`（返回 void），
 * 于是被闸门拦住时（上下文超预算、没有可用模型……）界面无从知道，
 * 却已经无条件清空了输入框 —— 用户打的字既没进会话、也从输入框消失了。
 *
 * 这里钉住契约本身：被接受 → `true`；被拒绝 → `false` 且错误写进 store。
 */
function createIdleProvider(): LLMProvider {
  return {
    id: 'idle',
    async *streamChat() {
      yield { kind: 'done', finishReason: 'stop' as const };
    },
    complete: async () => ok({ text: '' }),
    probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
  } as unknown as LLMProvider;
}

/** 让 `send` 的结果可切换：同一个 store 只能 bind 一次，所以用变量控制行为 */
let rejectNextSend = false;

function bindStore(): void {
  const base = createStores();
  const real = new ChatService(
    base.store,
    base.messages,
    createSettings(),
    createIdleProvider(),
    createWorkspaceToolRegistry(createFakeWorkspace().api),
  );

  // 只借它的快照与订阅（store 的其余部分与本次断言无关）
  const api: ChatApi = {
    subscribe: () => () => undefined,
    snapshot: () => real.snapshot(),
    isLoaded: () => real.isLoaded(),
    send: async () =>
      rejectNextSend ? err(appError('VALIDATION_ERROR', '上下文已超出预算')) : ok(undefined),
  } as unknown as ChatApi;

  useChatStore.getState().bind(api);
}

describe('chatStore.send 的返回契约', () => {
  it('被接受时返回 true，并清掉上一次的错误', async () => {
    bindStore();

    rejectNextSend = true;
    await expect(useChatStore.getState().send('这条发不出去')).resolves.toBe(false);
    expect(useChatStore.getState().error).toBe('上下文已超出预算');

    rejectNextSend = false;
    await expect(useChatStore.getState().send('这条可以')).resolves.toBe(true);
    // 成功即清空：错误代表"当前状态"，不是历史
    expect(useChatStore.getState().error).toBeNull();
  });
});
