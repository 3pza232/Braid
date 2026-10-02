import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import { estimateTokens } from '@domain/value-objects/usage';
import { ok } from '@shared/result';
import type { ChatStreamEvent } from '@ports/LLMProvider';
import type { SettingsApi } from '@ports/SettingsApi';
import { createFakeProvider, createFakeWorkspace, createStores } from '../helpers/chatHarness';

/**
 * 上下文压缩（compaction）—— 集成测试
 *
 * 领域层的"压哪一段"已有单测，但那证明不了**它被接上了**：
 * 引擎写得再对，只要 ChatService 忘了在发送前调用它，
 * 用户看到的就是"设置了自动压缩，上下文还是涨到爆"。
 * 这类"库存在但没接线"的问题，只有端到端发一次请求才能发现。
 */

/** 一"轮"的内容：300 个汉字 ≈ 510 token，用来快速把上下文顶起来 */
const turnText = (label: string) => `${label}内容`.repeat(60);

const done = (text: string): ChatStreamEvent[] => [
  { kind: 'delta', text },
  { kind: 'done', finishReason: 'stop' },
];

async function waitIdle(service: ChatService): Promise<void> {
  for (let waited = 0; waited < 600; waited += 1) {
    if (service.snapshot().streamingMessageId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function build(context: Partial<AppSettings['context']>, rounds: number) {
  const { store, messages } = createStores();
  const workspace = createFakeWorkspace();
  const tools = createWorkspaceToolRegistry(workspace.api);
  const { provider, requests, compressions } = createFakeProvider(
    Array.from({ length: rounds }, (_, index) => done(`第${index + 1}轮回答`)),
  );

  const settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.context = { ...settings.context, ...context };
  const settingsApi = {
    get: () => settings,
    isLoaded: () => true,
    load: async () => ok(settings),
    update: async () => ok(settings),
    reset: async () => ok(settings),
    subscribe: () => () => undefined,
  } as unknown as SettingsApi;

  return { service: new ChatService(store, messages, settingsApi, provider, tools), requests, compressions };
}

/**
 * 造一段"已经把上下文顶到触发线附近"的历史
 *
 * 预算 2200、触发线 85% = 1870；四轮各约 519 token → 约 2076：
 * 落在 [1870, 2200) 里，正好是"该压缩但还没到硬上限"的窗口。
 */
const NEAR_FULL = { maxContextTokens: 2700, reservedForOutput: 500, compressAt: 0.85 };

async function fillHistory(service: ChatService): Promise<void> {
  for (const label of ['第一轮', '第二轮', '第三轮', '第四轮']) {
    await service.send(turnText(label));
    await waitIdle(service);
  }
}

describe('自动压缩（compression: auto）', () => {
  it('涨到触发线后，下一次发送前会静默压缩一次', async () => {
    const { service, compressions } = build({ ...NEAR_FULL, compression: 'auto', keepRecentMessages: 1 }, 5);
    await service.load();
    await fillHistory(service);

    await service.send('继续');
    await waitIdle(service);

    // 触发线一到就压过至少一次（具体在哪一轮越线取决于字数估算，不写死轮次）
    expect(compressions.length).toBeGreaterThanOrEqual(1);
    // 是"把历史交给压缩器"，而不是"又发了一轮对话"
    const asked = String(compressions[0].messages.at(-1)?.content ?? '');
    expect(asked).toContain('压缩');
    expect(asked).toContain('第一轮内容');
  });

  it('下一个请求里带的是纪要，被覆盖的原文不再发送', async () => {
    const { service, requests } = build({ ...NEAR_FULL, compression: 'auto', keepRecentMessages: 1 }, 5);
    await service.load();
    await fillHistory(service);
    await service.send('继续');
    await waitIdle(service);

    const latest = requests.at(-1);
    const contents = (latest?.messages ?? []).map((message) => String(message.content));
    const all = contents.join('\n');

    expect(all).toContain('测试纪要');
    expect(all).toContain('继续');
    // 最早那一轮已经进了纪要，不再逐条发送
    expect(all).not.toContain('第一轮内容');
    // 最近一轮原文仍在（保留最近 N 轮）
    expect(all).toContain('第四轮内容');
  });

  it('压缩后的用量确实降下来了（不是压了个寂寞）', async () => {
    // 用"不压缩 + 手动压"来验证降幅：自动模式会在填历史的过程中就压掉，
    // 那时再取 before/after 比的其实是"压缩前后又发了一条消息"，结论没有意义
    const { service } = build(
      { maxContextTokens: 1_000_000, reservedForOutput: 4096, compression: 'off', compressAt: 0.85, keepRecentMessages: 1 },
      4,
    );
    await service.load();
    await fillHistory(service);
    const before = service.snapshot().context.usedTokens;

    await service.compressContext();

    expect(service.snapshot().context.usedTokens).toBeLessThan(before);
    expect(service.snapshot().context.summaryCount).toBe(1);
  });
});

describe('不压缩（compression: off）', () => {
  it('绝不自动改写历史', async () => {
    const { service, compressions } = build({ ...NEAR_FULL, compression: 'off', keepRecentMessages: 1 }, 5);
    await service.load();
    await fillHistory(service);
    await service.send('继续');
    await waitIdle(service);

    expect(compressions).toHaveLength(0);
  });

  it('超出上限时拦住发送，并说清楚下一步怎么做', async () => {
    const { service, requests } = build(
      { maxContextTokens: 200, reservedForOutput: 100, compression: 'off', compressAt: 0.85, keepRecentMessages: 1 },
      1,
    );
    await service.load();

    const result = await service.send(turnText('第一轮'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UPSTREAM_CONTEXT_TOO_LONG');
    // 一个字都没发出去 —— 拦住的意义就在这里
    expect(requests).toHaveLength(0);
    // 也没在树里留下半条空回复
    expect(service.snapshot().tree.nodes).toHaveLength(0);
    /*
     * 注意 `blocked` 此刻是 false，这是**对的**：
     * 它衡量的是"已经提交的上下文是否已经超线"，而这次被拦是因为
     * **这一条消息本身**太大（树里还什么都没有）。两者的补救方式不同 ——
     * 前者要压缩历史，后者只要把这一条写短一点或调大上限。
     * 界面上前者靠常驻提示条，后者靠这次发送返回的错误文案。
     */
    expect(service.snapshot().context.blocked).toBe(false);
  });

  it('提示里给出"压缩或调大上限"这两条可执行的路', async () => {
    const { service } = build(
      { maxContextTokens: 200, reservedForOutput: 100, compression: 'off', compressAt: 0.85, keepRecentMessages: 1 },
      1,
    );
    await service.load();
    const result = await service.send(turnText('第一轮'));

    if (!result.ok) {
      expect(result.error.message).toContain('压缩');
      expect(result.error.message).toContain('上下文长度');
    }
  });
});

describe('手动压缩（顶栏菜单的按钮）', () => {
  it('不压缩模式下手动点一下也能压', async () => {
    const { service, compressions } = build(
      { maxContextTokens: 1_000_000, reservedForOutput: 4096, compression: 'off', compressAt: 0.85, keepRecentMessages: 1 },
      4,
    );
    await service.load();
    await fillHistory(service);

    const report = await service.compressContext();

    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.data.coveredCount).toBeGreaterThan(0);
      expect(report.data.afterTokens).toBeLessThan(report.data.beforeTokens);
    }
    expect(compressions).toHaveLength(1);
  });

  it('没有可压的内容时明确说没有，而不是假装成功', async () => {
    const { service } = build({ ...NEAR_FULL, compression: 'off', keepRecentMessages: 1 }, 1);
    await service.load();
    await service.send(turnText('第一轮'));
    await waitIdle(service);

    const report = await service.compressContext();

    // 历史太短（不足 MIN_COVERED_TOKENS）→ 不值得压，如实回报
    expect(report.ok).toBe(false);
  });

  it('压缩失败（模型拒绝/网络问题）时不留半成品', async () => {
    const { store, messages } = createStores();
    const workspace = createFakeWorkspace();
    const tools = createWorkspaceToolRegistry(workspace.api);
    const { provider, compressions } = createFakeProvider(
      Array.from({ length: 4 }, (_, index) => done(`第${index + 1}轮回答`)),
      { completeFails: true },
    );
    const settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.context = { ...settings.context, ...NEAR_FULL, compression: 'off', keepRecentMessages: 1 };
    const settingsApi = {
      get: () => settings,
      isLoaded: () => true,
      load: async () => ok(settings),
      update: async () => ok(settings),
      reset: async () => ok(settings),
      subscribe: () => () => undefined,
    } as unknown as SettingsApi;
    const service = new ChatService(store, messages, settingsApi, provider, tools);
    await service.load();
    await fillHistory(service);

    const report = await service.compressContext();

    expect(report.ok).toBe(false);
    expect(compressions).toHaveLength(1);
    // 失败不写纪要：宁可什么都没发生，也不能留一段空白的"历史"
    expect(service.snapshot().context.summaryCount).toBe(0);
  });
});

describe('顶栏显示的口径', () => {
  it('只统计真正会发出去的内容（不是整棵树的正文）', async () => {
    const { service } = build({ ...NEAR_FULL, compression: 'auto', keepRecentMessages: 1 }, 5);
    await service.load();
    await fillHistory(service);

    const status = service.snapshot().context;
    // 四轮 × (300 汉字 + 短回答) ≈ 2000 上下，绝不该出现"整棵树被算了两遍"的浮夸数字
    expect(status.usedTokens).toBeLessThan(estimateTokens(turnText('第一轮')) * 4 + 500);
    expect(status.budget).toBe(2200);
    expect(status.ratio).toBeCloseTo(status.usedTokens / 2200, 5);
  });
});
