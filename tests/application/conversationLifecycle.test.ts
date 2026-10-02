import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { Conversation } from '@domain/entities/conversation';
import type { MessageStore } from '@ports/repositories/MessageStore';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { LLMProvider } from '@ports/LLMProvider';
import { appError, err, ok } from '@shared/result';
import { createFakeWorkspace, createSettings, createStores } from '../helpers/chatHarness';

/** 这些用例都不会真的生成：给一个"立刻结束"的提供方即可 */
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

/**
 * 会话的**创建与排序**：不许留下"幽灵状态"
 *
 * 这两条路径都先改内存、再落库，所以都有同一类风险：
 * **落库失败时内存没撤回**。表现是用户在列表里看到一条并不存在的会话，
 * 或者排序"点一下变个样、刷新又跳回去" —— 都属于"看着像小毛病、查起来毫无头绪"。
 *
 * 底层已经保证写盘要么全成、要么全不成（`saveMany` → `SqlPort.batch`），
 * 这里钉的是**应用层的对应责任**：失败就把内存回滚，并且批量而不是逐条写。
 */

/** 可以在指定次数上失败的会话仓储：其余行为全部转发给真夹具 */
function createControllableStore(inner: ConversationStore) {
  const state = { failSave: false, failSaveMany: false, saveCalls: 0, saveManyCalls: 0 };
  const batches: Conversation[][] = [];

  const store: ConversationStore = {
    list: () => inner.list(),
    save: async (conversation) => {
      state.saveCalls += 1;
      if (state.failSave) return err(appError('VALIDATION_ERROR', '写库失败（测试注入）'));
      return inner.save(conversation);
    },
    saveMany: async (items) => {
      state.saveManyCalls += 1;
      batches.push([...items]);
      if (state.failSaveMany) return err(appError('VALIDATION_ERROR', '批量写库失败（测试注入）'));
      return inner.saveMany(items);
    },
    remove: (id, now) => inner.remove(id, now),
  };

  return { store, state, batches };
}

/** 断言"这两个集合相等"时用：批次内的顺序跟随内部列表，不保证等于请求顺序 */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** 可以在保存消息时失败的聊天仓储 */
function createControllableMessages(inner: MessageStore) {
  const state = { failSave: false };
  const messages: MessageStore = {
    ...inner,
    save: async (node) => {
      if (state.failSave) return err(appError('VALIDATION_ERROR', '消息写库失败（测试注入）'));
      return inner.save(node);
    },
  };
  return { messages, state };
}

function assemble(options: { failConversationSave?: boolean; failConversationSaveMany?: boolean; failMessageSave?: boolean } = {}) {
  const base = createStores();
  const controllable = createControllableStore(base.store);
  const messageBag = createControllableMessages(base.messages);
  controllable.state.failSave = options.failConversationSave ?? false;
  controllable.state.failSaveMany = options.failConversationSaveMany ?? false;
  messageBag.state.failSave = options.failMessageSave ?? false;

  const provider = createIdleProvider();
  const workspace = createFakeWorkspace();

  const service = new ChatService(
    controllable.store,
    messageBag.messages,
    createSettings(),
    provider,
    createWorkspaceToolRegistry(workspace.api),
  );

  return { service, store: base.store, controllable, messageBag };
}

describe('创建会话', () => {
  it('落库失败时撤回乐观插入：列表与当前选中都回到原样', async () => {
    const { service, controllable } = assemble();
    await service.load();

    const before = service.snapshot();
    const listBefore = before.conversations.map((item) => item.id);
    const activeBefore = before.activeId;
    // 只有会话本身写不进去（消息没问题）：这条路径最容易被漏掉
    controllable.state.failSave = true;
    const created = await service.create(null);

    expect(created.ok).toBe(false);
    const after = service.snapshot();
    expect(after.conversations.map((item) => item.id)).toEqual(listBefore);
    expect(after.activeId).toBe(activeBefore);
  });

  it('会话写进去了、开场白没写进去 → 会话也要撤回（不留半成品）', async () => {
    const { service, store, messageBag } = assemble();
    await service.load();
    const listBefore = service.snapshot().conversations.length;

    messageBag.state.failSave = true;
    const role = {
      id: 'role-1',
      name: '有开场白的角色',
      greeting: '你好呀',
    } as unknown as Parameters<typeof service.create>[0];

    const created = await service.create(role);

    expect(created.ok).toBe(false);
    // 内存里没有它
    expect(service.snapshot().conversations).toHaveLength(listBefore);
    // 库里也没有它（否则下次启动会冒出一条没有开场白的空会话）
    const stored = await store.list();
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.data.filter((item) => item.title === '有开场白的角色')).toHaveLength(0);
    }
  });
});

describe('会话排序', () => {
  async function seedThree(service: ChatService) {
    await service.load();
    await service.create(null);
    await service.create(null);
    const ids = service.snapshot().conversations.map((item) => item.id);
    return ids;
  }

  it('一次批量写（不是逐条），顺序真的落到内存里', async () => {
    const { service, controllable } = assemble();
    const [first, second, third] = await seedThree(service);
    const before = controllable.state.saveManyCalls;

    const result = await service.reorderConversations([third!, first!, second!]);

    expect(result.ok).toBe(true);
    // 关键：整次排序只落一次库（底层是一个事务）
    expect(controllable.state.saveManyCalls).toBe(before + 1);
    expect(controllable.batches.at(-1)).toHaveLength(3);
    expect(service.snapshot().conversations.map((item) => item.id)).toEqual([third, first, second]);
  });

  it('落库失败时内存顺序**保持不变**（不留"半个新顺序"）', async () => {
    const { service, controllable } = assemble();
    const ids = await seedThree(service);
    const orderBefore = service.snapshot().conversations.map((item) => item.id);

    controllable.state.failSaveMany = true;
    const result = await service.reorderConversations([...ids].reverse());

    expect(result.ok).toBe(false);
    expect(service.snapshot().conversations.map((item) => item.id)).toEqual(orderBefore);
  });

  it('只给传进来的 id 编号：没在列表里的项保持不动', async () => {
    const { service, controllable } = assemble();
    const [first, second, third] = await seedThree(service);

    const result = await service.reorderConversations([third!, first!]);

    expect(result.ok).toBe(true);
    const batch = controllable.batches.at(-1) ?? [];
    // 只有被显式排过的两项落库（`second` 没在这份列表里，不该被悄悄改动）
    expect([...batch.map((item) => item.id)].sort()).toEqual([...sorted([third!, first!])]);
    // 编号按**传入的顺序**给：先传的拿 0
    expect(batch.find((item) => item.id === third)?.sortOrder).toBe(0);
    expect(batch.find((item) => item.id === first)?.sortOrder).toBe(1);
    expect(batch.some((item) => item.id === second)).toBe(false);
  });
});
