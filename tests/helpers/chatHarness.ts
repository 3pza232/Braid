import { ChatService } from '@app/chat/ChatService';
import {
  createWorkspaceToolRegistry,
  type ToolRegistry,
} from '@app/tools/workspaceToolRegistry';
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
  /**
   * 浏览器有没有授予这个目录的**写入**权限
   *
   * 这是现在唯一会让"写文件"失败的原因（早先还有一层"允许编辑"开关，已删掉 ——
   * 选中工作区就等于给了读写权）。把它做成可关闭的，是为了测"缺写入授权时"
   * 那句提示是否指对了地方。
   */
  writeGranted: boolean;
}

export function createFakeWorkspace(): FakeWorkspace {
  const state: FakeWorkspace = { writes: [], attempts: [], writeGranted: true, api: null as never };

  const snapshot = (): WorkspaceSnapshot => ({
    loaded: true,
    root: { id: 'fsw-1', label: '假工作区' },
    handleState: 'granted',
    writeState: state.writeGranted ? 'granted' : 'prompt',
    canRead: true,
    canWrite: state.writeGranted,
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
      if (!state.writeGranted) {
        return {
          ok: false,
          error: {
            code: 'FS_EDIT_DENIED',
            message: '浏览器还没授予这个目录的写入权限',
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

/* ────────────────────────── 假工具集 ────────────────────────── */

/**
 * 一个**不发任何工具声明**的工具集
 *
 * 【什么时候该用它】那些"需要一整个 ChatService、但并不关心工具"的用例。
 * 打开工作区之后，每个请求都会固定多带一份工具声明的 JSON（实测 3 个工具
 * ≈ 353 token），它会**悄悄挪动所有与上下文用量有关的数字** —— 于是"刚好卡在
 * 触发线上"这类用例开始在自己无关的地方变红，改一条工具描述也要跟着改预算。
 * 那说明这个耦合本身是错的：量压缩算术的用例，不该被工具声明的篇幅牵着走。
 *
 * **想量工具那份开销的用例请用真的 `createWorkspaceToolRegistry`** ——
 * 接线由 `contextBudgetRefresh.test.ts`（两个服务相减）与域层的
 * `contextCompression.test.ts`（公式）分别钉住。
 *
 * `run` 故意直接抛：用它的用例都不触发工具轮，真调到了说明接线错了，要立刻知道。
 */
export function createNoToolRegistry(): ToolRegistry {
  return {
    specs: () => [],
    promptSection: () => '',
    run: async () => {
      throw new Error('这个用例不该触发工具调用（它用的是 createNoToolRegistry）');
    },
  } as unknown as ToolRegistry;
}

/**
 * 同一套工具，但**不发 `tools` 声明**（`promptSection` 原样保留）
 *
 * 【和 `createNoToolRegistry()` 的区别，别用错】那个是"这个会话压根没有工具"，
 * 连系统提示词里那段能力说明一起没有；这个只是"不发那份 JSON 声明"，提示词照旧。
 *
 * 【什么时候要这个】用例的预算按**内容**标定、而系统提示词里那段说明本来就在算的时候。
 * 直接换 `createNoToolRegistry()` 会把那段说明也拿掉，预算的标定跟着偏 —— 症状是
 * 用例从"该压缩"变成"没到触发线"，红得莫名其妙（真踩到）。只掐声明则标定原样成立，
 * 而且改一条工具描述也不会连累这些用例。
 */
export function withoutToolSpecs(registry: ToolRegistry): ToolRegistry {
  return { ...registry, specs: () => [] };
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
  /** 浏览器授予写入权限了吗（唯一会让"写文件"失败的开关） */
  writeGranted?: boolean;
  /**
   * 用哪套工具集（默认真工具 —— 端到端别偷偷简化掉现实）
   *
   * 【什么时候要显式传 `createNoToolRegistry()`】用例按**内容**现算预算的时候。
   * 工具声明那份 JSON 是每个请求固定多出的一份开销（实测 3 个工具 ≈ 353 token），
   * 它会把"刚好卡在触发线上"这类数字整体顶过去，红在与自己无关的地方。
   */
  tools?: ToolRegistry;
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
  workspace.writeGranted = options.writeGranted ?? true;
  const tools = options.tools ?? createWorkspaceToolRegistry(workspace.api);
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
