import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { MessageStore } from '@ports/repositories/MessageStore';
import type { LLMProvider } from '@ports/LLMProvider';
import { appError, err, ok } from '@shared/result';
import { createFakeWorkspace, createSettings, createStores } from '../helpers/chatHarness';

/**
 * 「内容没落库」必须留痕
 *
 * 这类问题的形态是最难查的一种：**屏幕上一切正常** —— 回答一个字不少地长出来、
 * 能复制能编辑，只有重开页面才发现它没了。早先 `persistMessage` / `finalizeStream`
 * 把落库结果直接丢掉（`await this.messages.save(node);` 不看返回值），
 * 于是磁盘满、配额用尽、库被锁住……全都表现为"看起来一切正常"。
 *
 * 现在失败会写进快照的 `persistenceError`，由通知条送到用户眼前；写入恢复后自己消失
 * （它是当前状态，不是历史记录，否则一条持久错误提示会永远挂在界面上）。
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

/** 只让**收尾那一次**落库失败（流式过程中的周期落库照旧成功） */
function createFailingFinalizeMessages(base: MessageStore): {
  messages: MessageStore;
  heal: () => void;
} {
  let failing = true;
  return {
    messages: {
      ...base,
      save: async (node) => {
        if (failing && node.status === 'complete') {
          return err(appError('STORAGE_ERROR', '磁盘配额用尽'));
        }
        return base.save(node);
      },
    },
    heal: () => {
      failing = false;
    },
  };
}

function assemble(messages: MessageStore): ChatService {
  return new ChatService(
    createStores().store,
    messages,
    createSettings(),
    createIdleProvider(),
    createWorkspaceToolRegistry(createFakeWorkspace().api),
  );
}

/**
 * 等到某个条件成立
 *
 * 不能用"等 `streamingMessageId` 变 null"代替：收尾落库发生在流结束**之后**，
 * 前者先成立 —— 那会让断言跑在落库之前，测试本身变成随机的。
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('内容没落库时的留痕', () => {
  it('收尾落库失败会写进快照（而不是无声无息）', async () => {
    const flaky = createFailingFinalizeMessages(createStores().messages);
    const service = assemble(flaky.messages);
    await service.load();

    const sent = await service.send('你好');
    expect(sent.ok).toBe(true); // 发出去这一步是成功的：内容确实进了会话
    await waitFor(() => service.snapshot().persistenceError !== null);

    const error = service.snapshot().persistenceError;
    expect(error).not.toBeNull();
    expect(error).toContain('没能保存到本地');
    expect(error).toContain('磁盘配额用尽');
  });

  it('写入恢复之后，这条提示自己消失（它是状态，不是历史）', async () => {
    const flaky = createFailingFinalizeMessages(createStores().messages);
    const service = assemble(flaky.messages);
    await service.load();

    await service.send('第一条');
    await waitFor(() => service.snapshot().persistenceError !== null);

    flaky.heal();
    await service.send('第二条');
    await waitFor(() => service.snapshot().persistenceError === null);

    expect(service.snapshot().persistenceError).toBeNull();
  });

  it('一切正常时不产生这条提示（别把没问题的界面吓一跳）', async () => {
    const service = assemble(createStores().messages);
    await service.load();

    await service.send('你好');
    await waitFor(() => service.snapshot().streamingMessageId === null);
    // 再等一小会儿，给收尾落库留出发生的时间
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(service.snapshot().persistenceError).toBeNull();
  });
});
