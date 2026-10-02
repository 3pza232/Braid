import { describe, expect, it } from 'vitest';
import { activePathOf, cachedTreeIndex } from '@domain/rules/messageTree';
import { asMessageId } from '@shared/ids';
import { runConversation } from '../helpers/chatHarness';

/**
 * 删除消息的语义：**只删这一条**
 *
 * 用户明确要的是"删掉这一条"，后面说过的话是他自己写的、不该跟着消失。
 * 早先用的是级联软删（连同整棵子树），表现为"删一条，后面全没了" —— 那是错的。
 *
 * 现在的做法是把被删节点的孩子**接到它前面那条上**（在链上跳过一环），
 * 用例钉住的就是这件事在应用层真的成立（领域层的细节见
 * `tests/domain/messageTreeEdits.test.ts` 的 `withNodeRemoved`）。
 */
async function waitForIdle(service: { snapshot: () => { streamingMessageId: string | null } }) {
  for (let waited = 0; waited < 200 && service.snapshot().streamingMessageId !== null; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('删除消息', () => {
  it('删中间一条：后面的消息留在会话里，只少了一环', async () => {
    const { service } = await runConversation({
      prompt: '第一问',
      rounds: [
        [
          { kind: 'delta', text: '第一答' },
          { kind: 'done', finishReason: 'stop' },
        ],
        [
          { kind: 'delta', text: '第二答' },
          { kind: 'done', finishReason: 'stop' },
        ],
      ],
    });

    // 再问一轮，凑出 问1 → 答1 → 问2 → 答2
    await service.send('第二问');
    await waitForIdle(service);

    const before = service.snapshot().tree;
    const [q1, a1, q2, a2] = activePathOf(cachedTreeIndex(before.nodes), before.activeRootChildId);
    expect([q1?.id, a1?.id, q2?.id, a2?.id].filter(Boolean)).toHaveLength(4);

    // 删掉第一条回答
    await service.deleteMessage(a1!.id);

    const after = service.snapshot().tree;
    const path = activePathOf(cachedTreeIndex(after.nodes), after.activeRootChildId);

    // 被删的那条：软删（可恢复），后面的两条**原样还在**
    expect(after.nodes.find((item) => item.id === a1!.id)?.deletedAt).not.toBeNull();
    expect(path.map((item) => item.id)).toEqual([q1!.id, q2!.id, a2!.id]);

    // 接过来的那条换了父节点（不是挂在已删除的消息下面）
    expect(after.nodes.find((item) => item.id === q2!.id)?.parentId).toBe(q1!.id);
  });

  it('删最后一条：前面的对话原样保留', async () => {
    const { service } = await runConversation({
      prompt: '唯一的一问',
      rounds: [
        [
          { kind: 'delta', text: '唯一的一答' },
          { kind: 'done', finishReason: 'stop' },
        ],
      ],
    });

    const before = service.snapshot().tree;
    const path = activePathOf(cachedTreeIndex(before.nodes), before.activeRootChildId);
    const answer = path[path.length - 1]!;

    await service.deleteMessage(answer.id);

    const after = service.snapshot().tree;
    const remaining = activePathOf(cachedTreeIndex(after.nodes), after.activeRootChildId);
    expect(remaining.map((item) => item.id)).toEqual([path[0]!.id]);
  });

  it('删一条不存在的消息：什么都不发生（不制造半个状态）', async () => {
    const { service } = await runConversation({ rounds: [[{ kind: 'done', finishReason: 'stop' }]] });
    const before = service.snapshot().tree.nodes.length;

    const result = await service.deleteMessage(asMessageId('msg-ghost'));

    expect(result.ok).toBe(true);
    expect(service.snapshot().tree.nodes).toHaveLength(before);
  });
});
