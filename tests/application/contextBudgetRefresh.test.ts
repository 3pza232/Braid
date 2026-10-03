import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry, type ToolRegistry } from '@app/tools/workspaceToolRegistry';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import { effectiveMaxOutput } from '@domain/value-objects/sampling';
import { toolSpecTokensOf } from '@app/chat/messageAssembly';
import type { SettingsApi } from '@ports/SettingsApi';
import { ok } from '@shared/result';
import {
  createFakeProvider,
  createFakeWorkspace,
  createStores,
  withoutToolSpecs,
} from '../helpers/chatHarness';

/** 这个文件里的服务用**真**工具集（见下面那条"相减"的用例） */
function realTools(): ToolRegistry {
  return createWorkspaceToolRegistry(createFakeWorkspace().api);
}

/**
 * 改「单轮输出上限」之后，顶栏那条进度条必须立刻反映新预算
 *
 * 【为什么值得单独钉一条】预算 = 上下文长度 − 单轮输出上限，两个都是设置项。
 * 快照里的上下文状态虽然是**读取时现算**的（`contextManager.status()` 每次都重新解析设置），
 * 但快照本身只在发送、切换会话、压缩这些时机才被提交 —— 于是用户改完设置后，
 * 进度条要等到下次发送才动，看起来就是"改了没反应"（用户实际反馈）。
 * 现在服务订阅了设置变化，这两条用例分别钉住"该重算时重算"与"不该重算时不算"。
 *
 * 这个文件同时也是**工具声明那份开销的接线处**：能拿到"有工具 / 没工具"两个服务
 * 相减，正好用来验证 ChatService 真的把它喂进了用量。
 */
function build(tools: ToolRegistry = realTools()) {
  const { store, messages } = createStores();
  const { provider } = createFakeProvider([]);

  let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  const listeners: Array<(next: AppSettings) => void> = [];

  const api = {
    get: () => settings,
    isLoaded: () => true,
    load: async () => ok(settings),
    update: async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
      return ok(settings);
    },
    reset: async () => ok(settings),
    subscribe: (listener: (next: AppSettings) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  } as unknown as SettingsApi;

  const service = new ChatService(store, messages, api, provider, tools);
  let snapshots = 0;
  service.subscribe(() => {
    snapshots += 1;
  });

  return {
    service,
    /** 模拟"设置服务通知了一次变化" */
    apply: (next: AppSettings) => {
      settings = next;
      for (const listener of listeners) listener(next);
    },
    snapshots: () => snapshots,
  };
}

describe('设置变化 → 快照刷新（顶栏进度条）', () => {
  it('把「单轮输出上限」调大 → 预算立刻变小，不用等下一次发送', async () => {
    const { service, apply, snapshots } = build();
    await service.load();

    const before = service.snapshot().context.budget;
    // 默认预算 = 默认上下文长度 − 默认单轮输出上限（`effectiveMaxOutput` 是唯一的取值口径）
    expect(before).toBe(
      DEFAULT_APP_SETTINGS.context.maxContextTokens - effectiveMaxOutput(DEFAULT_APP_SETTINGS.sampling),
    );
    const emittedBefore = snapshots();

    const next = structuredClone(DEFAULT_APP_SETTINGS);
    next.sampling = { ...next.sampling, maxTokens: 100_000 };
    apply(next);

    // 重新提交过快照，而且预算按新上限算
    expect(snapshots()).toBeGreaterThan(emittedBefore);
    expect(service.snapshot().context.budget).toBe(before - 100_000 + 8192);
  });

  it('改与预算无关的设置（温度）→ 一条也不发', async () => {
    const { service, apply, snapshots } = build();
    await service.load();
    const emittedBefore = snapshots();

    const next = structuredClone(DEFAULT_APP_SETTINGS);
    next.sampling = { ...next.sampling, temperature: 0.5 };
    apply(next);

    /*
     * 这条是性能护栏：滑块一拖会触发几十次更新，每次都拿整个对话重算一遍用量
     * 是没有必要的开销（长对话上尤其明显）。只有影响预算的两个字段才值得重算。
     */
    expect(snapshots()).toBe(emittedBefore);
  });

  /*
   * 顶栏的用量里必须含"请求里 tools 那份 JSON"
   *
   * 【为什么拿两个服务相减】这样期望值是从工具集自己算出来的（改一条工具描述，
   * 它就跟着变），而不是写死一个数字等着过期。它钉的是**接线**：公式（相加项）在
   * `tests/domain/contextCompression.test.ts`，这里只管 ChatService 真的把它喂进去了。
   *
   * 它是系统提示词之外的第二份工具信息（提示词里那段文字说明本来就在 `systemPrompt`
   * 里算着），早先整份漏算 —— 长对话里只占零点几个百分点，短对话上能偏低七成。
   */
  it('用量里含「tools 那份 JSON」：把声明去掉，用量正好少这么多', async () => {
    const registry = realTools();
    const withTools = build(registry);
    /*
     * 同一套工具，只是不发声明（`promptSection` 原样保留）
     *
     * 不能换成 `createNoToolRegistry()`：那样连系统提示词里那段文字说明也没了，
     * 差值就变成"两份东西之和"。只掐掉声明之后，两个服务的提示词逐字相同，
     * 差值**只**来自那份 JSON。
     */
    const withoutSpecs = build(withoutToolSpecs(registry));
    await withTools.service.load();
    await withoutSpecs.service.load();

    // 期望值用**同一处口径**现算（改一条工具描述，它就跟着变），而不是写死一个数字
    const specTokens = toolSpecTokensOf(registry.specs());
    expect(specTokens).toBeGreaterThan(0);

    expect(
      withTools.service.snapshot().context.usedTokens -
        withoutSpecs.service.snapshot().context.usedTokens,
    ).toBe(specTokens);
  });
});
