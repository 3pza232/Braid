import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { Conversation } from '@domain/entities/conversation';
import type { MessageNode, MessageSegment } from '@domain/entities/message';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import type { ChatStreamEvent, LLMProvider } from '@ports/LLMProvider';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { MessageStore } from '@ports/repositories/MessageStore';
import type { SettingsApi } from '@ports/SettingsApi';
import type { WorkspaceApi, WorkspaceSnapshot } from '@ports/WorkspaceApi';
import { ok } from '@shared/result';

/* ────────────────────────── 假仓储 ────────────────────────── */

export function createStores(): { store: ConversationStore; messages: MessageStore } {
  const conversations: Conversation[] = [];
  const byConversation = new Map<string, MessageNode[]>();

  return {
    store: {
      list: async () => ok([...conversations]),
      save: async (conversation) => {
        const index = conversations.findIndex((item) => item.id === conversation.id);
        if (index >= 0) conversations[index] = conversation;
        else conversations.push(conversation);
        return ok(undefined);
      },
      // 与真实仓储同语义：批量写也是一次性生效（夹具里同样是"要么都写、要么没写"）
      saveMany: async (items) => {
        for (const conversation of items) {
          const index = conversations.findIndex((item) => item.id === conversation.id);
          if (index >= 0) conversations[index] = conversation;
          else conversations.push(conversation);
        }
        return ok(undefined);
      },
      remove: async (id) => {
        const index = conversations.findIndex((item) => item.id === id);
        if (index >= 0) conversations.splice(index, 1);
        return ok(undefined);
      },
    },
    messages: {
      listByConversation: async (id) => ok(byConversation.get(id) ?? []),
      listAll: async () => ok([...byConversation.values()].flat()),
      save: async (node) => {
        const list = byConversation.get(node.conversationId) ?? [];
        const index = list.findIndex((item) => item.id === node.id);
        if (index >= 0) list[index] = node;
        else list.push(node);
        byConversation.set(node.conversationId, list);
        return ok(undefined);
      },
      saveMany: async (nodes) => {
        for (const node of nodes) {
          const list = byConversation.get(node.conversationId) ?? [];
          list.push(node);
          byConversation.set(node.conversationId, list);
        }
        return ok(undefined);
      },
      purge: async () => ok(undefined),
      // 搜索的两个查询在夹具里用不到：搜索的判定逻辑是纯函数，另有单测覆盖
      findCandidates: async () => ok([]),
      listLinks: async () => ok([]),
    },
  };
}

export function createSettings(mutate?: (settings: AppSettings) => void): SettingsApi {
  const value = structuredClone(DEFAULT_APP_SETTINGS);
  mutate?.(value);
  return {
    get: () => value,
    isLoaded: () => true,
    load: async () => ok(value),
    update: async () => ok(value),
    reset: async () => ok(value),
    subscribe: () => () => undefined,
  } as unknown as SettingsApi;
}

/* ────────────────────────── 假工作区 ────────────────────────── */

export interface FakeWorkspace {
  api: WorkspaceApi;
  writes: Array<{ path: string; content: string }>;
  /** 记录**尝试**写入的路径（含被拒的）：区分"没落盘"与"根本没尝试" */
  attempts: string[];
  allowEdit: boolean;
}

export function createFakeWorkspace(): FakeWorkspace {
  const state: FakeWorkspace = { writes: [], attempts: [], allowEdit: true, api: null as never };

  const snapshot = (): WorkspaceSnapshot => ({
    loaded: true,
    root: { id: 'fsw-1', label: '假工作区' },
    handleState: 'granted',
    writeState: state.allowEdit ? 'granted' : 'prompt',
    canRead: true,
    canWrite: state.allowEdit,
    permission: { allowEdit: state.allowEdit, source: 'global' },
    supported: true,
    unsupportedReason: null,
    entries: [],
    error: null,
  });

  state.api = {
    snapshot,
    isLoaded: () => true,
    load: async () => ok(snapshot()),
    subscribe: () => () => undefined,
    selectDirectory: async () => ok(null),
    clearDirectory: async () => ok(undefined),
    reauthorize: async () => ok('granted'),
    authorizeWrite: async () => ok('granted'),
    refresh: async () => ok([]),
    listFiles: async () => ok([]),
    readFile: async () => ok('（假文件内容）'),
    writeFile: async (path: string, content: string) => {
      state.attempts.push(path);
      if (!state.allowEdit) {
        return {
          ok: false,
          error: {
            code: 'FS_EDIT_DENIED',
            message: '编辑工作区文件未获授权',
            retryable: false,
          },
        } as never;
      }
      state.writes.push({ path, content });
      return ok(undefined) as never;
    },
    subscribeAlerts: () => () => undefined,
    pruneHandles: async () => ok(0) as never,
  } as unknown as WorkspaceApi;

  return state;
}

/* ────────────────────────── 假模型 ────────────────────────── */

export interface RecordedRequest {
  tools?: unknown;
  params?: { maxTokens?: number };
  messages: Array<Record<string, unknown>>;
}

export function createFakeProvider(
  rounds: ChatStreamEvent[][],
  options: { summaryText?: string; completeFails?: boolean } = {},
): {
  provider: LLMProvider;
  requests: RecordedRequest[];
  /** 每次压缩请求（`complete`），用于断言"压了什么" */
  compressions: Array<{ messages: Array<Record<string, unknown>> }>;
} {
  const requests: RecordedRequest[] = [];
  const compressions: Array<{ messages: Array<Record<string, unknown>> }> = [];
  let index = 0;

  const provider = {
    id: 'fake',
    async *streamChat(request: RecordedRequest): AsyncIterable<ChatStreamEvent> {
      requests.push(request);
      const events = rounds[index] ?? [{ kind: 'done', finishReason: 'stop' as const }];
      index += 1;
      for (const event of events) yield event;
    },
    /**
     * 压缩用的一次性补全
     *
     * 默认返回一段可辨认的纪要文本：测试靠它断言"纪要真的进了下一次请求"，
     * 而不只是"压缩被调用过"。
     */
    complete: async (request: { messages: Array<Record<string, unknown>> }) => {
      compressions.push(request);
      if (options.completeFails) {
        return {
          ok: false,
          error: { code: 'UPSTREAM_BAD_REQUEST', message: '压缩失败', retryable: false },
        } as never;
      }
      return ok({ text: options.summaryText ?? '【测试纪要】此前发生过一些事。' }) as never;
    },
    probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
  } as unknown as LLMProvider;

  return { provider, requests, compressions };
}

/* ────────────────────────── 组装 ────────────────────────── */

export interface RunResult {
  service: ChatService;
  workspace: FakeWorkspace;
  requests: RecordedRequest[];
  /** 压缩请求（`provider.complete`）—— 用来断言"生成过程中压过" */
  compressions: Array<{ messages: Array<Record<string, unknown>> }>;
  node: MessageNode | null;
  nodes: MessageNode[];
}

export async function runConversation(options: {
  settings?: AppSettings;
  rounds: ChatStreamEvent[][];
  allowEdit?: boolean;
  prompt?: string;
  /**
   * 发送之前的挂钩，拿到的是**已经装配好、还没开始跑**的服务
   *
   * 给"运行中插一手"的用例用：订阅快照、在某个状态出现时按停止。
   * 比 `setTimeout` 靠谱 —— 那种写法要么偶发、要么得等上几百毫秒。
   */
  beforeSend?: (service: ChatService) => void | Promise<void>;
}): Promise<RunResult> {
  const { store, messages } = createStores();
  const workspace = createFakeWorkspace();
  workspace.allowEdit = options.allowEdit ?? true;
  const tools = createWorkspaceToolRegistry(workspace.api);
  // 需要压制上下文压缩的用例请改用 tests/application/contextCompression.test.ts 里的装配
  const { provider, requests, compressions } = createFakeProvider(options.rounds);

  const settings: AppSettings = options.settings ?? DEFAULT_APP_SETTINGS;
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
  // 可以是异步的：需要"先把历史垫起来"的用例要在里面 send + 等它跑完
  await options.beforeSend?.(service);
  await service.send(options.prompt ?? '帮我写点东西');

  // runStream 是"发射后不管"的，轮询直到它结束
  for (let waited = 0; waited < 600; waited += 1) {
    if (service.snapshot().streamingMessageId === null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const nodes = service.snapshot().tree.nodes;
  return {
    service,
    workspace,
    requests,
    compressions,
    nodes,
    node: nodes.find((item) => item.role === 'assistant') ?? null,
  };
}

export const textOf = (node: MessageNode | null): string =>
  (node?.segments ?? [])
    .map((segment: MessageSegment) => (segment.kind === 'text' ? segment.text : ''))
    .join('');

export const kinds = (node: MessageNode | null): string =>
  (node?.segments ?? []).map((segment) => segment.kind).join(',');
