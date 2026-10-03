import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import type { TokenUsage } from '@domain/value-objects/usage';
import type { ChatStreamEvent, LLMProvider } from '@ports/LLMProvider';
import type { SettingsApi } from '@ports/SettingsApi';
import type { StreamPhase } from '@ports/ChatApi';
import { ok } from '@shared/result';
import { asToolCallId } from '@shared/ids';
import { createFakeWorkspace, createStores } from '../helpers/chatHarness';

/**
 * 流式期间的**阶段**与**用量**
 *
 * 这两件事要钉的是同一类问题：**中途看不到**。
 *  - 阶段：界面靠它自动展开 / 折叠「思考过程」与「文件工具」两个面板，
 *    而"开始说正文就折叠、中途再思考 / 调用工具再展开"是逐轮发生的；
 *  - 用量：协议上 usage 随最后一个 chunk 才发回，所以在那一轮结束之前，
 *    只能给界面一个**本地估算**（带 `≈`），否则整条长回答写完前那个数字一直是空的。
 *
 * 【为什么要一个"慢"的假模型】`chatHarness` 的剧本式 provider 把整轮事件一次排完，
 * 于是"流到一半时的快照"根本观察不到。这里每个事件之间留 150ms ——
 * 跨过服务端 120ms 的 flush 节流，每个事件都会留下一次可观察的快照。
 */

const STEP_MS = 150;

/** 慢速流：事件之间隔一会儿，好让"中途"被看见 */
async function* slowStream(events: readonly ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    yield event;
  }
}

interface Step {
  /** 那一刻快照里的阶段 */
  phase: StreamPhase | null;
  /** 那一刻正在生成的那条消息上的用量 */
  usage: TokenUsage | undefined;
  /** 那一刻树里有没有"已经露头、但还没有结果"的工具调用 */
  pendingToolCall: boolean;
  /** 那一刻树里有没有已经拿到结果的工具调用 */
  settledToolCall: boolean;
}

function build(events: readonly ChatStreamEvent[]) {
  const { store, messages } = createStores();
  const workspace = createFakeWorkspace();
  const tools = createWorkspaceToolRegistry(workspace.api);

  const settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  const settingsApi = {
    get: () => settings,
    isLoaded: () => true,
    load: async () => ok(settings),
    update: async () => ok(settings),
    reset: async () => ok(settings),
    subscribe: () => () => undefined,
  } as unknown as SettingsApi;

  /*
   * 剧本**只服务第一轮**，之后的轮次直接收工
   *
   * 分轮脚本在这里不需要（这几个用例只关心"第一轮流到一半时快照长什么样"），
   * 而"每轮都重放同一串"会要命：工具轮之后模型又"要求调用工具"，
   * 于是一路跑到轮数上限（第一次写这个用例就是这么超时的）。
   */
  let consumed = false;
  const provider = {
    id: 'slow-fake',
    streamChat: () => {
      if (consumed) return slowStream([done()]);
      consumed = true;
      return slowStream(events);
    },
  } as unknown as LLMProvider;

  const service = new ChatService(store, messages, settingsApi, provider, tools);

  /** 每一步的观察结果（订阅到的每一次快照都记一笔） */
  const steps: Step[] = [];
  service.subscribe((snapshot) => {
    const streaming = snapshot.tree.nodes.find((node) => node.id === snapshot.streamingMessageId);
    const target = streaming ?? snapshot.tree.nodes.at(-1);
    const segments = target?.segments ?? [];
    const callIds = new Set(
      segments.filter((segment) => segment.kind === 'tool_call').map((segment) => segment.call.id),
    );
    const resultIds = new Set(
      segments.filter((segment) => segment.kind === 'tool_result').map((segment) => segment.callId),
    );

    steps.push({
      phase: snapshot.streamPhase,
      usage: target?.usage,
      pendingToolCall: [...callIds].some((id) => !resultIds.has(id)),
      settledToolCall: resultIds.size > 0,
    });
  });

  return { service, steps, workspace };
}

async function waitIdle(service: ChatService): Promise<void> {
  for (let waited = 0; waited < 600; waited += 1) {
    if (service.snapshot().streamingMessageId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const EXACT: TokenUsage = { promptTokens: 400, completionTokens: 100, totalTokens: 500 };
const done = (): ChatStreamEvent => ({ kind: 'done', finishReason: 'stop' });

describe('流式期间：阶段（供界面自动展开面板）', () => {
  it('思考 → 正文：阶段按顺序推进，收工后回到 null', async () => {
    const { service, steps } = build([
      { kind: 'reasoning', text: '让我想想。' },
      { kind: 'delta', text: '答案是' },
      { kind: 'delta', text: '四。' },
      done(),
    ]);

    await service.load();
    await service.send('一加三等于几');
    await waitIdle(service);

    const phases = steps.map((step) => step.phase);
    expect(phases).toContain('reasoning');
    expect(phases).toContain('text');
    // 收工后没有"此刻"：过程面板回到默认收起
    expect(phases.at(-1)).toBeNull();
    // 顺序也要求对：思考必须先于正文（否则"开始说话就折叠"就无从谈起）
    expect(phases.indexOf('reasoning')).toBeLessThan(phases.indexOf('text'));
  });
});

describe('流式期间：用量（估算 → 准确值）', () => {
  it('中途给的是本地估算（带 estimated 标记），这一轮结束后换成准确值', async () => {
    const { service, steps } = build([
      { kind: 'delta', text: '先写一段。' },
      { kind: 'usage', usage: EXACT },
      done(),
    ]);

    await service.load();
    await service.send('写点东西');
    await waitIdle(service);

    // 中途：出现过估算（界面上显示成 `≈`）
    const estimatedSteps = steps.filter((step) => step.usage?.estimated === true);
    expect(estimatedSteps.length).toBeGreaterThan(0);
    // 估算的数字不是 0：用户看到的是"在涨"，而不是一个空位
    expect(estimatedSteps.some((step) => (step.usage?.totalTokens ?? 0) > 0)).toBe(true);

    // 定稿：整份换成服务商的准确值，`estimated` 消失（`≈` 随之不见）
    const finalUsage = service.snapshot().tree.nodes.at(-1)?.usage;
    expect(finalUsage?.totalTokens).toBe(EXACT.totalTokens);
    expect(finalUsage?.estimated).toBeUndefined();
  });
});

describe('流式期间：工具「先露头」', () => {
  it('工具执行前就能看到那条调用（结果还没回来），阶段为 tool', async () => {
    const { service, steps } = build([
      { kind: 'delta', text: '我来看看目录。' },
      {
        kind: 'tool_call',
        call: {
          id: asToolCallId('call-1'),
          name: 'list_dir',
          argumentsJson: '{"path":"."}',
          parsed: { path: '.' },
        },
      },
      done(),
      { kind: 'delta', text: '看完了，没有文件。' },
      done(),
    ]);

    await service.load();
    await service.send('看下工作区有什么');
    await waitIdle(service);

    /*
     * 这一条钉的是"写文件之前必须露头"：那正是 `runToolRound` 里
     * "先固化、再执行"的顺序 —— 界面上表现为"有个调用已经挂在树上、结果还没回来"，
     * 而面板的自动展开就看这一刻。
     */
    expect(steps.some((step) => step.pendingToolCall)).toBe(true);
    expect(steps.map((step) => step.phase)).toContain('tool');
    // 然后才是结果到达（说明上一步的"悬空"不是因为它没被执行）
    expect(steps.some((step) => step.settledToolCall)).toBe(true);
    // 最后模型重新开口 → 阶段回到正文
    expect(steps.map((step) => step.phase)).toContain('text');
  });
});
