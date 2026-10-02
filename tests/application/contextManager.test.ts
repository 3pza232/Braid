import { describe, expect, it } from 'vitest';
import { createContextManager, type ContextManagerDeps } from '@app/chat/contextManager';
import { createEmptyConversation } from '@domain/entities/conversation';
import type { MessageNode } from '@domain/entities/message';
import type { TreeState } from '@domain/rules/messageTreeEdits';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import type { ResolvedConfig } from '@domain/rules/resolveConfig';
import type { LLMProvider } from '@ports/LLMProvider';
import type { SettingsApi } from '@ports/SettingsApi';
import { asConversationId, asMessageId, type ConversationId } from '@shared/ids';
import { ok } from '@shared/result';
import { node } from '../helpers/messageNode';

/**
 * 上下文管理器（从 ChatService 搬出来的第一个协作者）
 *
 * 搬它之前这块**完全没有测试**：用量怎么算、发送前的闸门拦不拦、压缩成不成，
 * 只能端到端发一次请求才知道。现在它只依赖"取值函数 + 提交 + 通知"，
 * 于是这些分支可以在不启动任何仓储的情况下逐条钉住 —— 这正是拆它的收益。
 *
 * 端到端那条路径另有 `contextCompression.test.ts` 盯着（它证明"接线没断"），
 * 这里管的是**每条分支自己**对不对。
 */

/**
 * 一"轮"的内容：800 个汉字
 *
 * 刻意写得够大：`planCompression` 有一条"可压内容太少就别压了"的下限
 * （压一次要花一次模型调用，收益太小时不值得），内容太少会直接拿到"没有可压缩的历史"。
 */
const text = '内容'.repeat(200);

function buildTree(count: number): TreeState {
  const nodes: MessageNode[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push(
      node(`m${index}`, {
        parentId: index === 0 ? null : asMessageId(`m${index - 1}`),
        role: index % 2 === 0 ? 'user' : 'assistant',
        segments: [{ kind: 'text', text }],
        // 串成一条激活路径：不设它，路径会在第一条就停住
        activeChildId: index === count - 1 ? null : asMessageId(`m${index + 1}`),
      }),
    );
  }
  return { nodes, activeRootChildId: count > 0 ? asMessageId('m0') : null };
}

interface Setup {
  budget?: number;
  keepRecent?: number;
  compression?: AppSettings['context']['compression'];
  nodes?: number;
  streaming?: boolean;
  compressing?: boolean;
  summaryText?: string;
  completeFails?: boolean;
}

function setup(options: Setup = {}) {
  const settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.context = {
    ...settings.context,
    maxContextTokens: options.budget ?? 100_000,
    reservedForOutput: 0,
    keepRecentMessages: options.keepRecent ?? 2,
    compressAt: 0.5,
    compression: options.compression ?? 'off',
  };

  const conversation = createEmptyConversation(asConversationId('conv-1'), 0, { title: '测试会话' });
  let tree = buildTree(options.nodes ?? 8);
  let commits = 0;
  let completions = 0;
  const compressingLog: boolean[] = [];
  let note: string | null = null;
  let emitted = 0;

  const settingsApi = { get: () => settings, isLoaded: () => true, load: async () => ok(settings), update: async () => ok(settings) } as unknown as SettingsApi;
  const provider = {
    id: 'fake',
    async *streamChat() {
      yield { kind: 'done', finishReason: 'stop' as const };
    },
    complete: async () => {
      completions += 1;
      if (options.completeFails) throw new Error('不应该走到压缩请求');
      return ok({ text: options.summaryText ?? '这是纪要' });
    },
    probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
  } as unknown as LLMProvider;

  const deps: ContextManagerDeps = {
    settings: settingsApi,
    provider,
    activeConversation: () => conversation,
    activeTree: () => tree,
    streamingId: () => (options.streaming === true ? asMessageId('m-streaming') : null),
    isCompressing: () => compressingLog.at(-1) === true || options.compressing === true,
    setCompressing: (value) => compressingLog.push(value),
    setNote: (value) => {
      note = value;
    },
    commit: async (conversationId: ConversationId, next: TreeState) => {
      commits += 1;
      expect(conversationId).toBe(conversation.id);
      tree = next;
      return ok(undefined);
    },
    emit: () => {
      emitted += 1;
    },
  };

  return {
    manager: createContextManager(deps),
    conversation,
    tree: () => tree,
    counts: () => ({ commits, completions, emitted }),
    compressingLog,
    note: () => note,
  };
}

describe('用量状态', () => {
  it('按当前会话与树现算，并给出比例与"是否必须先压缩"', () => {
    const test = setup({ budget: 100_000 });
    const status = test.manager.status();

    // 8 条各 240 字的节点：用量必须是个正数，且比例与两者一致
    expect(status.usedTokens).toBeGreaterThan(0);
    expect(status.budget).toBe(100_000);
    expect(status.ratio).toBeCloseTo(status.usedTokens / status.budget, 6);
    expect(status.blocked).toBe(false);
    expect(status.summaryCount).toBe(0);
    expect(status.lastCompressedAt).toBeNull();
  });

  it('预算很小的时候标记为"必须先压缩"（这条闸门不看自动压缩设置）', () => {
    const test = setup({ budget: 10 });
    const status = test.manager.status();

    expect(status.usedTokens).toBeGreaterThanOrEqual(status.budget);
    expect(status.blocked).toBe(true);
  });
});

describe('该不该自动压缩', () => {
  const config = (patch: Partial<ResolvedConfig> = {}): ResolvedConfig =>
    ({ contextBudget: 1000, compressAt: 0.7, compression: 'auto', ...patch }) as ResolvedConfig;

  const cases: Array<{ name: string; config: ResolvedConfig; used: number; expected: boolean }> = [
    { name: '关掉自动压缩 → 永不自动压', config: config({ compression: 'off' }), used: 900, expected: false },
    { name: '没有预算 → 不自动压', config: config({ contextBudget: 0 }), used: 900, expected: false },
    { name: '已超限 → 不自动压（交给闸门拦住，让用户自己决定）', config: config(), used: 1000, expected: false },
    { name: '到触发线但没超限 → 压', config: config(), used: 700, expected: true },
    { name: '没到触发线 → 不压', config: config(), used: 699, expected: false },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const test = setup();
      expect(test.manager.shouldAutoCompress(testCase.config, testCase.used)).toBe(testCase.expected);
    });
  }
});

describe('发送前的闸门', () => {
  it('正在压缩时不放行（两条路径同时改树会互相覆盖）', async () => {
    const test = setup({ compressing: true });
    const result = await test.manager.prepare('你好');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('空间足够时放行，且不去打扰模型', async () => {
    const test = setup({ budget: 100_000 });
    const result = await test.manager.prepare('你好');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tree).toBe(test.tree());
    expect(test.counts().completions).toBe(0);
  });

  it('关掉自动压缩时超限**也不会偷偷压**，而是拦住并说明下一步', async () => {
    const test = setup({ budget: 10, compression: 'off' });
    const result = await test.manager.prepare('你好');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UPSTREAM_CONTEXT_TOO_LONG');
      // 报错里要给出可执行的动作，而不是一句"上下文太长"
      expect(result.error.message).toContain('上下文按钮');
    }
    expect(test.counts().completions).toBe(0);
  });

  it('开了自动压缩且到触发线：先压一次，压完就放行', async () => {
    /*
     * 预算从**实测用量**推出来（1.5 倍），而不是写一个魔法数字：
     * 这样它必然落在"到触发线（0.67 ≥ compressAt 0.5）但还没超限"的区间里，
     * 不会被 token 估算比例的具体细节绊住。
     */
    const probe = setup({ nodes: 16 });
    const used = probe.manager.status().usedTokens;

    const test = setup({
      nodes: 16,
      budget: Math.round(used * 1.5),
      compression: 'auto',
      keepRecent: 2,
    });
    const result = await test.manager.prepare('你好');

    // 自动压了一次（说明这条路真的通了）
    expect(test.counts().completions).toBe(1);
    // 压完空间够了 → 放行。这正是自动压缩存在的意义
    expect(result.ok).toBe(true);
  });
});

describe('压缩', () => {
  it('生成过程中不许压缩（会与流式同时改树）', async () => {
    const test = setup({ streaming: true });
    const result = await test.manager.compress();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('生成过程中');
    expect(test.counts().completions).toBe(0);
  });

  it('没有可压的历史时给的是"接下来能做什么"，而不是"失败了"', async () => {
    // 只有 2 条、保留最近 2 轮 → 无可压内容
    const test = setup({ nodes: 2, keepRecent: 2, compression: 'off' });
    const result = await test.manager.compress();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('没有可压缩的历史了');
      expect(result.error.message).toContain('上下文长度');
    }
  });

  it('压成功：标记被覆盖的节点、写纪要、提交一次、状态复位、给出提示', async () => {
    const test = setup({ nodes: 16, keepRecent: 2, summaryText: '前半段的纪要' });
    const result = await test.manager.compress();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coveredCount).toBeGreaterThan(0);

    // 被覆盖的节点打上标记，其余保持不动（原文一字不删，只是不再发送）
    const summarized = test.tree().nodes.filter((item) => item.contextFlags?.summarized === true);
    expect(summarized).toHaveLength(result.data.coveredCount);
    expect(test.tree().nodes.some((item) => item.contextFlags?.summarized !== true)).toBe(true);

    expect(test.counts().commits).toBe(1);
    // 忙碌标记必须成对出现：只置 true 不置 false 会让顶栏一直转圈、且再也压不了
    expect(test.compressingLog).toEqual([true, false]);
    expect(test.note()).toContain('纪要');
  });

  it('压缩失败时也要把忙碌标记复位（否则"正在压缩"会永远挂着）', async () => {
    const test = setup({ nodes: 16, keepRecent: 2, completeFails: true });
    await expect(test.manager.compress()).rejects.toThrow();

    expect(test.compressingLog).toEqual([true, false]);
  });
});
