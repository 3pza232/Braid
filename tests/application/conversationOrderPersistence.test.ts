import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import { createEmptyConversation } from '@domain/entities/conversation';
import type { MessageStore } from '@ports/repositories/MessageStore';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { LLMProvider } from '@ports/LLMProvider';
import { asConversationId } from '@shared/ids';
import { ok } from '@shared/result';
import { createFakeWorkspace, createSettings, createStores } from '../helpers/chatHarness';

/**
 * 拖动出来的顺序，**刷新之后还在**
 *
 * 曾经的 bug：用户拖完顺序，按 F5 又变回去了。
 * 查下来数据一直是**对的** —— `sort_order` 好好写在库里，只是 `load()` 直接采用了
 * 存储返回的顺序（`updated_at DESC`），没人拿 `sort_order` 去排。
 * 这类"写对了、读的时候没人看"的问题最容易被误判成"没存进去"，所以它值得一个
 * 专门的回归文件：把"重启之后顺序如何"当成一条独立契约钉住。
 *
 * （角色列表一直是重排的，所以只有会话有这个毛病。）
 */

/** 这些用例都不真的生成：给一个"立刻结束"的提供方即可 */
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

function assembly(): {
  service: ChatService;
  store: ConversationStore;
  messages: MessageStore;
} {
  const base = createStores();
  const service = new ChatService(
    base.store,
    base.messages,
    createSettings(),
    createIdleProvider(),
    createWorkspaceToolRegistry(createFakeWorkspace().api),
  );
  return { service, store: base.store, messages: base.messages };
}

const NOW = 1_700_000_000_000;

function make(id: string, title: string, sortOrder: number | null, updatedAt: number) {
  return {
    ...createEmptyConversation(asConversationId(id), NOW, { title }),
    sortOrder,
    updatedAt,
  };
}

/**
 * 三条会话，**存储返回的顺序与手动序相反**
 *
 * 这是关键：存储按 `updated_at DESC`（C 最旧、A 最新）返回，
 * 而手动序要求 C → B → A。如果 `load()` 不重排，断言就会看到 A → B → C。
 */
async function seedOutOfOrder(store: ConversationStore): Promise<void> {
  await store.save(make('conv-a', 'A', 2, NOW + 3000));
  await store.save(make('conv-b', 'B', 1, NOW + 2000));
  await store.save(make('conv-c', 'C', 0, NOW + 1000));
}

describe('会话顺序的持久化', () => {
  it('装载时按手动序重排，而不是照搬存储顺序', async () => {
    const { service, store } = assembly();
    await seedOutOfOrder(store);

    await service.load();

    expect(service.snapshot().conversations.map((item) => item.title)).toEqual(['C', 'B', 'A']);
  });

  it('没手动排过的排在已排过的之后，其内部仍按最近使用', async () => {
    const { service, store } = assembly();
    await seedOutOfOrder(store);
    // D 没被手动排过，但它是最新的
    await store.save(make('conv-d', 'D', null, NOW + 9999));
    // E 也没排过，比 D 旧
    await store.save(make('conv-e', 'E', null, NOW + 500));

    await service.load();

    expect(service.snapshot().conversations.map((item) => item.title)).toEqual([
      'C',
      'B',
      'A',
      'D',
      'E',
    ]);
  });

  it('已有手动序时，新建会话拿到更小的编号 —— 刷新后仍在最前', async () => {
    const { service, store } = assembly();
    await seedOutOfOrder(store);
    await service.load();

    const created = await service.create(null);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 比现有最小值（0）更小：不必重编号别人的行
    expect(created.data.sortOrder).toBe(-1);
    expect(service.snapshot().conversations[0]?.id).toBe(created.data.id);

    // 关键：库里也是这个编号，否则下次装载它又会掉下去
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.find((item) => item.id === created.data.id)?.sortOrder).toBe(-1);

    // 再装载一次 = 用户按了一次 F5：顺序必须与刚才一致
    await service.load();
    expect(service.snapshot().conversations[0]?.id).toBe(created.data.id);
  });

  it('从没手动排过时不写多余编号（交给"最近使用"决定）', async () => {
    const { service } = assembly();
    await service.load(); // 空库 → 自动建第一条

    const created = await service.create(null);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.sortOrder).toBeNull();
  });

  it('拖动后立刻重排内存列表，并且只把变了的行写进库', async () => {
    const { service, store } = assembly();
    await seedOutOfOrder(store);
    await service.load();

    const result = await service.reorderConversations([
      asConversationId('conv-c'),
      asConversationId('conv-a'),
    ]);

    expect(result.ok).toBe(true);
    // C(0) 不变、A(1) 改了、B 没被提到 → 保持 1 不动
    expect(service.snapshot().conversations.map((item) => item.title)).toEqual(['C', 'A', 'B']);
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.find((item) => item.title === 'A')?.sortOrder).toBe(1);
    expect(listed.data.find((item) => item.title === 'B')?.sortOrder).toBe(1);
  });
});
