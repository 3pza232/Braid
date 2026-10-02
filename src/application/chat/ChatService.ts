import { nanoid } from 'nanoid';
import type { Conversation } from '@domain/entities/conversation';
import {
  createEmptyConversation,
  DEFAULT_CONVERSATION_TITLE,
  deriveTitleFromText,
} from '@domain/entities/conversation';
import type {
  FinishReason,
  MessageNode,
  MessageSegment,
  MessageStatus,
  ToolCall,
} from '@domain/entities/message';
import { withStreamedContent } from '@domain/entities/message';
import type { RolePreset } from '@domain/entities/rolePreset';
import { instantiateRole } from '@domain/entities/roleInstance';
import { resolveMacros } from '@domain/rules/macroResolver';
import { activePathIdsOf, cachedTreeIndex, shiftVariant } from '@domain/rules/messageTree';
import { CANDIDATE_LIMIT, searchVisibleAcrossConversations } from '@app/chat/messageSearch';
import { decideContinuation } from './continuation';
import { buildRoundRequest } from './roundRequest';
import { classifyStreamOutcome } from './streamOutcome';
import { runToolRound } from './toolRound';
import { orderConversations, renumberByOrder, topOrderOf } from '@domain/rules/manualOrder';
import {
  activeLeafIdOf,
  withActiveChild,
  withNodeAdded,
  withNodeTextPatched,
  withNodeRemoved,
  type TreeState,
} from '@domain/rules/messageTreeEdits';
import { conversationToMarkdown } from '@domain/rules/conversationMarkdown';

import type { ResolvedConfig } from '@domain/rules/resolveConfig';
import type { AppSettings } from '@domain/value-objects/appSettings';
import { activeSummaryOf } from '@domain/value-objects/contextSummary';
import { effectiveMaxOutput } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';
import { addUsage } from '@domain/value-objects/usage';
import {
  buildProviderMessages,
  changedNodes,
  createNode,
  resolveUsage,
  serializePrompt,
} from '@app/chat/messageAssembly';
import { createContextManager, type ContextManager } from '@app/chat/contextManager';
import type { ToolRegistry } from '@app/tools/workspaceToolRegistry';
import type {
  ChatApi,
  ChatSnapshot,
  ContextCompressionReport,
  EditSubmitMode,
} from '@ports/ChatApi';
import type { LLMProvider } from '@ports/LLMProvider';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { MessageSearchHit, MessageStore } from '@ports/repositories/MessageStore';
import type { SettingsApi } from '@ports/SettingsApi';
import { asConversationId, type ConversationId, type MessageId } from '@shared/ids';
import { appError, err, ok, toAppError, type AppError, type Result } from '@shared/result';



/**
 * 流式渲染节流
 *
 * 模型每秒能吐几十个 token，若每来一个就 setState，一秒内会触发几十次
 * 整棵树的重渲染 + diff，长回答下会明显掉帧。合并到约 8 次/秒，
 * 视觉上依然是"逐字流出"，但渲染开销降到 1/10。
 */
const STREAM_FLUSH_MS = 120;

/**
 * 流式落库节流（比渲染更宽松）
 *
 * 每次 flush 都写 SQLite 会让磁盘 IO 成为流式的瓶颈。折中：**界面照常高频刷新，
 * 数据库约 1.5 秒 checkpoint 一次**，生成结束/中止时无条件写一次。
 * 最坏情况（进程被杀）损失约 1.5 秒的文本，换来的是流式期间几乎零 IO 压力。
 */
const STREAM_PERSIST_MS = 1500;

/**
 * 一次回复里允许的最大工具轮数
 *
 * 必须有上限：模型偶尔会陷入"读一下、再读一下"的循环，
 * 没有上限就会一直烧 token，而且界面永远不会结束。
 * 8 轮足够完成"看目录 → 读几个文件 → 写几个文件 → 总结"这类常见任务。
 */
const MAX_TOOL_ROUNDS = 8;

/**
 * 单条消息允许的最大续写轮数
 *
 * 这是**最后一道闸**：正常情况下停顿检测与软上限会先触发，
 * 轮数上限只在"每轮都写出了一点新内容但永远到不了下限"这种病态情况下兜底。
 * 60 轮按每轮 2k 字算是 12 万字，已覆盖最长的档位。
 */
const MAX_CONTINUATION_ROUNDS = 60;

const emptyTree = (): TreeState => ({ nodes: [], activeRootChildId: null });

/**
 * 兜底会话
 *
 * 正常流程**永远用不到**：`load()` 与 `remove()` 都保证"至少存在一个会话"。
 * 但万一这个不变量被破坏，界面也不该白屏 —— 所以留一个不会持久化的空壳。
 */
const SAFETY_CONVERSATION = createEmptyConversation(asConversationId('safety-net'), 0, {
  title: DEFAULT_CONVERSATION_TITLE,
});

/**
 * 会话与消息树服务（应用层）
 *
 * 【职责边界】
 *  - 持有会话列表、每个会话的消息树、当前选中会话；
 *  - 把消息操作交给 `@domain/rules` 的**纯函数**，自己只负责"存下来 + 落库"；
 *  - 对 UI 只暴露"读快照 + 发命令"，界面不参与任何业务判断。
 *
 * 【为什么把会话列表放在服务里而不是 store】
 * store 是"视图状态镜像"，会随框架更换；而"哪个会话当前选中""删完最后一个要补一个"
 * 是业务规则。放这里，它就能在 Node 里跑单测。
 *
 * 【消息树的持久化策略：按对象身份做差量】
 * 领域函数是**不可变**的：未改动的节点返回同一个对象引用，改动的才新建对象。
 * 所以"diff 出要写哪些节点"只需要比较引用，无需手工追踪脏标记 ——
 * 这是纯函数设计带来的免费收益，也让每次切换变体只写 1 行而不是整棵树。
 */
export class ChatService implements ChatApi {
  private conversations: Conversation[] = [];
  private readonly threads = new Map<ConversationId, TreeState>();
  private activeId: ConversationId | null = null;
  private loaded = false;
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();

  /** 正在流式生成的消息；非 null 时禁止并发发送 */
  private streamingId: MessageId | null = null;
  /**
   * 正在流式生成的那个**会话**
   *
   * 存在的理由只有一个：会话被删除时要能判断"要不要顺手中止它"。
   * 删掉一个正在生成的会话，用户的本意往往就是"别写了"；
   * 不中止的话请求会继续跑到结束（继续烧 token），
   * 而 `streamingId` 一直非 null —— 用户在新会话里点发送会被"上一条还在生成中"
   * 挡住，却找不到那条流在哪里。
   */
  private streamingConversationId: ConversationId | null = null;
  /**
   * 「已经有人的回复正在路上」的**同步**占位
   *
   * 为什么不能只靠 `streamingId`：它要等 `runStream` 真正开跑才被设置，
   * 而在此之前还有两次数据库往返。用户快速按两下回车（或双击发送）时，
   * 第二次会在这个窗口里通过检查 —— 结果是两条流同时生成，
   * 而后设的中止句柄会覆盖前一个，**第一条流就再也停不下来了**。
   * 这个标记在进入入口的那一刻同步竖起，一直举到 `streamingId` 接手。
   */
  private replyInFlight = false;
  /** 正在压缩：界面据此把按钮切到"压缩中…"，并拦住并发压缩 */
  private compressing = false;
  /**
   * 最近一次请求为塞进上下文做过什么
   *
   * 由 `planContext` 的产出翻译而来，跟着快照送到顶栏 —— 裁剪发生时
   * 发出去的内容与屏幕上看到的不再完全一致，用户有权知道这件事。
   */
  private contextNote: string | null = null;

  /**
   * 内容没能写进本地库（`null` = 没问题）
   *
   * 与"命令失败"分开成一件事：命令失败是这次操作没成功，用户马上能看到；
   * 而这个表达的是**屏幕上一切正常、但其实没落库** —— 重开页面才发现长回答没了。
   * 那是最难排查的一类问题，所以单独留一条通道送到界面上（见 `ui/components/Notices`）。
   */
  private persistenceError: string | null = null;
  /** 当前流式请求的中止句柄 */
  private abortController: AbortController | null = null;

  /**
   * 「每轮询问」档位下，那条**正在等用户点头**的回复
   *
   * 界面据此长出一个「继续写」按钮。刻意存成"当前状态"而不是消息上的字段：
   * 它表达的是"现在轮到你决定了"，不是"这条消息曾经怎样"—— 后者要写进库就得迁移，
   * 而它对解释历史毫无用处（重开应用后想接着写，打一个「继续」发出去同样做得到）。
   * 代价如实说明：应用重启后这个按钮不会回来。
   */
  private continuableId: MessageId | null = null;

  /**
   * 每个会话「上一次请求的 prompt 序列化结果」
   *
   * 只用于缓存命中估算（服务端没给缓存字段时的兜底），因此**不持久化**：
   * 重启后第一条消息没有基准，就先不显示估算值 —— 比拿一个错误的基准去算要好。
   */
  private readonly lastPromptByConversation = new Map<ConversationId, string>();

  /**
   * 上下文：状态 / 发送前的闸门 / 压缩
   *
   * 从本类搬出去的第一个协作者（实现与理由见 `contextManager.ts`）。
   * 它只拿到"取值函数 + 提交 + 通知"，所以本类的状态一个都不用重写。
   */
  private readonly context: ContextManager;

  constructor(
    private readonly store: ConversationStore,
    private readonly messages: MessageStore,
    private readonly settings: SettingsApi,
    private readonly provider: LLMProvider,
    /** 工具集与执行器（含工作区的编辑门禁） */
    private readonly tools: ToolRegistry,
  ) {
    this.context = createContextManager({
      settings: this.settings,
      provider: this.provider,
      activeConversation: () => this.getActiveConversation(),
      activeTree: () => this.getActiveTree(),
      streamingId: () => this.streamingId,
      isCompressing: () => this.compressing,
      setCompressing: (value) => {
        this.compressing = value;
      },
      setNote: (note) => {
        this.contextNote = note;
      },
      commit: (conversationId, next, patch) => this.commit(conversationId, next, patch),
      emit: () => this.emit(),
    });

    /*
     * 设置变了 → 重新提交一次快照
     *
     * 【为什么需要这一条】顶栏那条进度条的预算 = 上下文长度 − 单轮输出上限，两个都是设置项。
     * 快照里的上下文状态**每次现算**（`contextManager.status()` 会重新解析设置），
     * 但快照本身只在发送、切换会话、压缩这些时机才被提交 —— 于是用户改完「单轮输出上限」，
     * 进度条要等到下次发送才动，看起来就是"改了没反应"（真实反馈）。
     *
     * 只看**影响预算的两个字段**：温度之类的滑块一拖会触发几十次更新，
     * 每次拿整个对话重算一遍用量是没有必要的开销（长对话上尤其明显）。
     */
    let budgetKey = budgetKeyOf(this.settings.get());
    this.settings.subscribe((next) => {
      const key = budgetKeyOf(next);
      if (key === budgetKey) return;
      budgetKey = key;
      this.emit();
    });
  }

  /* ────────────────────────── 读取 ────────────────────────── */

  snapshot(): ChatSnapshot {
    return {
      conversations: this.conversations,
      activeId: this.activeId,
      conversation: this.getActiveConversation(),
      tree: this.getActiveTree(),
      streamingMessageId: this.streamingId,
      continuableMessageId: this.continuableId,
      contextNote: this.contextNote,
      context: this.context.status(),
      compressing: this.compressing,
      persistenceError: this.persistenceError,
    };
  }

  /** 按 id 找一个会话（流式回调里不能用"当前会话"：用户可能已经切走） */
  private getConversationById(id: ConversationId): Conversation | null {
    return this.conversations.find((item) => item.id === id) ?? null;
  }


  stop(): void {
    this.abortController?.abort();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ────────────────────────── 装载 ────────────────────────── */

  async load(): Promise<Result<void>> {
    const listed = await this.store.list();
    if (!listed.ok) return listed;

    /*
     * 必须**按同一套规则重排**，不能直接用存储返回的顺序
     *
     * 存储按 `updated_at DESC` 返回，而列表展示用的是"手动序优先"。
     * 早先这里直接赋值，于是用户拖出来的顺序只活在内存里：一刷新就回到
     * "最近使用" —— 数据其实已经写进 `sort_order` 了，只是显示时没人去看它。
     * （角色那边一直是重排的，所以只有会话有这个问题。）
     */
    this.conversations = orderConversations(listed.data);

    // 首次启动（或用户删光后重启）补一个空会话：聊天界面需要一个落点
    if (this.conversations.length === 0) {
      const created = await this.create(null);
      if (!created.ok) return created;
      this.loaded = true;
      this.emit();
      return ok(undefined);
    }

    this.activeId = this.conversations[0]?.id ?? null;
    const tree = await this.loadTree(this.activeId);
    if (!tree.ok) return tree;

    this.loaded = true;
    this.emit();
    return ok(undefined);
  }

  /* ────────────────────────── 会话列表 ────────────────────────── */

  async create(role: RolePreset | null): Promise<Result<Conversation>> {
    const now = Date.now();
    const id = asConversationId(`conv-${nanoid(10)}`);

    const conversation = createEmptyConversation(id, now, {
      // 用角色开新对话时直接拿角色名当标题：用户刚从角色面板点过来，
      // 一看标题就知道"这是那个角色的对话"，比默认的「新对话」有用得多。
      // 之后 send() 只在标题仍是「新对话」时才自动改标题，所以不会被首句话覆盖。
      title: role ? role.name : DEFAULT_CONVERSATION_TITLE,
      roleId: role?.id ?? null,
      roleInstance: role ? instantiateRole(role, now) : null,
    });

    // 角色配了开场白就预填第一条 AI 消息，让新会话不是一片空白
    let tree = emptyTree();
    let greeting: MessageNode | null = null;
    if (role && role.greeting.trim().length > 0) {
      greeting = createNode({
        conversationId: id,
        parentId: null,
        role: 'assistant',
        text: role.greeting,
        variantIndex: 0,
        now,
        modelRef: role.model,
      });
      tree = withNodeAdded(tree, greeting);
      conversation.activeRootChildId = tree.activeRootChildId;
    }

    /*
     * 新会话排在**所有已手动排过的**之前
     *
     * 只靠"数组前面插一个"是不够的：没编号的项按规则排在已排过的之后，
     * 刷新一次它就掉下去了。所以当列表里已经存在手动序时，给它一个更小的编号
     * （没有手动序时不写编号，交给"最近使用"排）。
     */
    conversation.sortOrder = topOrderOf(this.conversations);
    this.conversations = [conversation, ...this.conversations];
    this.threads.set(id, tree);
    const previousActiveId = this.activeId;
    this.activeId = id;
    this.emit();

    const savedConversation = await this.store.save(conversation);
    if (!savedConversation.ok) {
      this.rollbackCreate(id, previousActiveId);
      return savedConversation;
    }

    if (greeting) {
      const savedGreeting = await this.messages.save(greeting);
      if (!savedGreeting.ok) {
        /*
         * 会话已落库、开场白没落：**整体撤回**
         *
         * `create` 是"要么完整成功、要么什么都没发生"的操作。
         * 留一个没有开场白的会话，用户会以为数据丢了；而下次再建一条，
         * 库里就多出一条他看不见的空壳。
         */
        await this.store.remove(id, Date.now());
        this.rollbackCreate(id, previousActiveId);
        return savedGreeting;
      }
    }

    return ok(conversation);
  }

  /**
   * 撤回 `create` 的乐观插入
   *
   * 不撤的话，界面上会留下一条**数据库里并不存在**的会话：用户看到它、
   * 点进去、发消息，全都在一个不存在的 id 上打转，而且刷新一次它就"凭空消失"。
   */
  private rollbackCreate(id: ConversationId, previousActiveId: ConversationId | null): void {
    this.conversations = this.conversations.filter((item) => item.id !== id);
    this.threads.delete(id);
    this.activeId = previousActiveId;
    this.emit();
  }

  async select(id: ConversationId): Promise<Result<void>> {
    if (this.activeId === id) return ok(undefined);
    if (!this.conversations.some((item) => item.id === id)) return ok(undefined);

    this.activeId = id;
    // 先切换再加载：界面立刻高亮，消息随后到位（首次进入才查库）
    this.emit();

    const tree = await this.loadTree(id);
    if (!tree.ok) return tree;

    this.emit();
    return ok(undefined);
  }

  /**
   * 手动排序
   *
   * 顺序写进会话行（`sort_order`），因此导入导出、备份都会带上它。
   * 只给传进来的 id 编号：被搜索过滤掉、没显示的那些保持不动。
   */
  async reorderConversations(orderedIds: ConversationId[]): Promise<Result<void>> {
    const next = renumberByOrder(this.conversations, orderedIds);
    // `renumberByOrder` 只替换真的变了的项，所以引用不同的就是需要落库的那些
    const changed = next.filter((conversation, index) => conversation !== this.conversations[index]);

    /*
     * 一次事务写完（而不是逐条 save）
     *
     * 排序是"整体"的属性：逐条写中途失败会留下**半个新顺序** ——
     * 每一行都合法，合起来却是乱的，而且用户完全看不出发生过什么。
     * 底层 `saveMany` 走 `SqlPort.batch`，要么全写、要么一条不写。
     */
    if (changed.length > 0) {
      const saved = await this.store.saveMany(changed);
      if (!saved.ok) return saved;
    }

    this.conversations = orderConversations(next);
    this.emit();
    return ok(undefined);
  }

  async remove(id: ConversationId): Promise<Result<void>> {
    const removed = await this.store.remove(id, Date.now());
    if (!removed.ok) return removed;

    /*
     * 删的正好是正在生成的那个会话 —— 立刻中止它的请求
     *
     * 用户删一个正在狂写的会话，本意基本都是"别写了"。若不中止，请求会一直跑到
     * 结束，`streamingId` 也不会释放，用户在新会话里点发送只会被
     * 「上一条还在生成中」挡住，却找不到那条流在哪儿。
     */
    if (this.streamingConversationId === id) this.abortController?.abort();

    this.conversations = this.conversations.filter((item) => item.id !== id);
    this.threads.delete(id);
    // 缓存命中估算的基准也是按会话存的，跟着一起删 —— 否则每删一个会话就残留一条
    this.lastPromptByConversation.delete(id);

    if (this.conversations.length === 0) {
      // 删光了就自动开一个新的，而不是把界面留在"没有会话"的死状态
      const created = await this.create(null);
      if (!created.ok) return created;
      this.emit();
      return ok(undefined);
    }

    if (this.activeId === id) {
      const next = this.conversations[0];
      if (next) {
        this.activeId = next.id;
        const tree = await this.loadTree(next.id);
        if (!tree.ok) return tree;
      }
    }

    this.emit();
    return ok(undefined);
  }

  async rename(id: ConversationId, title: string): Promise<Result<void>> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return ok(undefined);
    return this.persistConversation({ ...conversation, title, updatedAt: Date.now() });
  }

  /**
   * 导出某条会话为 Markdown
   *
   * 直接读**那条**会话的消息（不切过去）：导出列表里的另一条时改变当前选中会很突兀。
   * 内容按激活路径筛、跳过软删除 —— 规则在 `domain/rules/conversationMarkdown.ts`。
   */
  async exportConversation(id: ConversationId): Promise<Result<string>> {
    const conversation = this.getConversationById(id);
    if (!conversation) return err(appError('VALIDATION_ERROR', '这条会话已经不在了'));

    const listed = await this.messages.listByConversation(id);
    if (!listed.ok) return listed;

    return ok(
      conversationToMarkdown({
        conversation,
        nodes: listed.data,
        exportedAt: Date.now(),
      }),
    );
  }

  async updateActive(patch: Partial<Conversation>): Promise<Result<void>> {
    const conversation = this.getActiveConversation();
    return this.persistConversation({ ...conversation, ...patch, updatedAt: Date.now() });
  }

  async resyncRole(role: RolePreset): Promise<Result<void>> {
    const conversation = this.getActiveConversation();
    return this.persistConversation({
      ...conversation,
      roleId: role.id,
      roleInstance: instantiateRole(role, Date.now()),
      updatedAt: Date.now(),
    });
  }

  /* ────────────────────────── 消息树 ────────────────────────── */

  /**
   * 独占开始一次回复：并发检查 → 占位 → 执行 → **无论成败都释放占位**
   *
   * 用 try/finally，而不是在三个入口各自的每个返回点补一句释放 ——
   * 那些分支加起来有七八个提前返回，漏掉任何一条都会**把发送功能永久锁死**，
   * 而 try/finally 不给这个机会。
   *
   * 占位与 `streamingId` 是**交接**关系而非各管一段：`runStream` 一开跑就设置
   * `streamingId` 并释放占位，中间没有任何一刻是"没人负责"的。
   */
  private async exclusiveReply(task: () => Promise<Result<void>>): Promise<Result<void>> {
    const busy = this.claimReply();
    if (busy) return busy;
    try {
      return await task();
    } finally {
      this.replyInFlight = false;
    }
  }

  /** 并发检查 + 竖起占位；返回非空表示"现在不能发" */
  private claimReply(): Result<void> | null {
    if (this.streamingId === null && !this.replyInFlight) {
      this.replyInFlight = true;
      return null;
    }
    // 三处入口共用这一句：并发被拒时该说的话只有一句，重复三遍只会改漏
    return err(appError('VALIDATION_ERROR', '上一条还在生成中，先点停止或等它结束'));
  }

  async send(text: string): Promise<Result<void>> {
    return this.exclusiveReply(() => this.sendNow(text));
  }

  /**
   * `send` 的实际内容
   *
   * 拆出来的理由只有一个：并发占位必须**包住整段**（见 exclusiveReply）。
   * 把 send 的主题体整体缩进一层进 try/finally 也能做到，但这里是改动最频繁的地方，
   * 整段缩进会让之后每一次 diff 都变脏，所以宁可多一层同名方法。
   */
  private async sendNow(text: string): Promise<Result<void>> {
    /*
     * 先过上下文闸门
     *
     * 必须在**建任何节点之前**：闸门拦住时不该在树里留下一条空回复。
     * 它同时负责"到触发线就压缩"，并把压缩后的最新会话与树交回来 ——
     * 压缩会改标记与会话行，用旧引用继续会让这些改动被下一次提交覆盖掉。
     */
    const ready = await this.context.prepare(text);
    if (!ready.ok) return ready;

    const { conversation, tree, config } = ready.data;
    const now = Date.now();
    const parentId = activeLeafIdOf(tree);
    const index = cachedTreeIndex(tree.nodes);
    const siblingCount = (index.childIdsOf.get(parentId) ?? []).length;

    const userNode = createNode({
      conversationId: conversation.id,
      parentId,
      role: 'user',
      text,
      variantIndex: siblingCount,
      now,
    });

    const next = withNodeAdded(tree, userNode);

    // 首条消息顺便定标题；已经改过标题的会话不覆盖用户的命名
    const patch: Partial<Conversation> =
      conversation.title === DEFAULT_CONVERSATION_TITLE
        ? { title: deriveTitleFromText(text) }
        : {};

    const committed = await this.commit(conversation.id, next, patch);
    if (!committed.ok) return committed;

    return this.spawnReply(conversation, next, userNode.id, config);
  }

  /**
   * 在某条消息下面生成一条回复
   *
   * 抽出来是因为有三条路径要用：正常发送、编辑用户提问后重发、角色开场后的首轮。
   * 先落一条**空正文、streaming 状态**的节点，界面立刻有落点 ——
   * 用户点完马上看到"已经在生成"，而不是等首 token 才冒出气泡。
   */
  private async spawnReply(
    conversation: Conversation,
    tree: TreeState,
    parentId: MessageId | null,
    config: ResolvedConfig,
  ): Promise<Result<void>> {
    const now = Date.now();
    const index = cachedTreeIndex(tree.nodes);
    const siblingCount = (index.childIdsOf.get(parentId) ?? []).length;

    const assistantNode = createNode({
      conversationId: conversation.id,
      parentId,
      role: 'assistant',
      text: '',
      status: 'streaming',
      variantIndex: siblingCount,
      now,
      modelRef: config.model || null,
      paramsSnapshot: config.params,
      // 记下"当时用的是哪个角色"：将来角色改了、删了，这条消息仍然能解释自己怎么来的
      roleIdAtCreation: conversation.roleInstance?.roleId ?? null,
    });

    const next = withNodeAdded(tree, assistantNode);
    const committed = await this.commit(conversation.id, next);
    if (!committed.ok) return committed;

    // 不 await：请求在后台跑。界面此刻已可交互，发送键已变成停止键
    void this.runStream(conversation.id, assistantNode.id, next, config, now);

    return ok(undefined);
  }

  /* ────────────────────────── 流式生成 ────────────────────────── */

  /**
   * 执行一次流式生成
   *
   * 三条纪律：
   *  1. **界面高频刷新、数据库低频写入** —— 渲染节流 120ms，落库节流 1.5s，
   *     结束/中止时无条件补一次。流式期间几乎不产生磁盘 IO。
   *  2. **任何路径都必须留下内容** —— 失败、中止、异常都要把已产出的正文落库，
   *     并把原因写进消息（Schema 里没有错误字段，见 FAILURE_MARK 的注释）。
   *  3. **prompt 序列化必须稳定** —— 缓存命中估算依赖"与上次的公共前缀"，
   *     任何抖动（时间戳、重排）都会让估算失去意义。
   */
  private async runStream(
    conversationId: ConversationId,
    messageId: MessageId,
    treeAtSend: TreeState,
    config: ResolvedConfig,
    startedAt: number,
    /**
     * 续写起点：这条消息**已经定稿的段**
     *
     * 只有「每轮询问」会用（用户点「继续写」时）：那条消息已经写了几轮、
     * 停在半途，重新开一次轮次循环必须让模型先看到已经写出来的部分 ——
     * 否则它会从头再写一遍。段本身就是"已收工的轮次"的记录，交给它最准确：
     * 拼出来的请求与上一轮**逐字节一致**，前缀缓存也照旧命中。
     */
    seed?: { segments: readonly MessageSegment[] },
  ): Promise<void> {
    const systemPrompt = resolveMacros(config.systemPrompt, {
      ...config.variables,
      // 只到"天"：精确到秒会让系统提示词每轮都变，前缀缓存全失效
      date: new Date(startedAt).toISOString().slice(0, 10),
    });

    /*
     * 能力说明追加在系统提示词后面
     *
     * 为什么光靠 `tools` 参数不够：它只声明"有哪些函数"，不说明
     * "工作区选没选、能不能写"。模型不知道编辑开关的状态就会盲目调用
     * write_file，而用户看到的是一串失败。把状态明确写给它，
     * 它才会在没权限时**直接向用户要授权**，而不是反复重试。
     */
    const toolSection = this.tools.promptSection();
    const fullSystemPrompt =
      toolSection.length > 0 ? `${systemPrompt}\n\n${toolSection}` : systemPrompt;

    /*
     * 已生效的纪要要插在系统提示词之后
     *
     * 【为什么这里是个可以重算的函数】
     * 早先这是"取一次就不变"：一轮生成期间不允许压缩。现在**轮与轮之间允许压缩**
     *（开了自动压缩时，到触发线就自己压一次再接着写，见轮次循环里那段），
     * 压缩会把更早的历史换成新纪要 —— 那时 `summaryText` / `history` / `promptText`
     * 都必须重算，否则刚压掉的内容照样被发出去，等于压缩白做。
     */
    let summaryText = activeSummaryOf(this.getConversationById(conversationId))?.text ?? null;
    const buildHistory = () =>
      buildProviderMessages(
        fullSystemPrompt,
        this.threads.get(conversationId) ?? treeAtSend,
        messageId,
        summaryText,
      );

    let history = buildHistory();
    let promptText = serializePrompt(history);
    const previousPrompt = this.lastPromptByConversation.get(conversationId) ?? '';
    this.lastPromptByConversation.set(conversationId, promptText);

    const controller = new AbortController();
    // 上一次的裁剪说明属于上一条回复，新的一轮开始就清掉，避免显示成"这次的"
    this.contextNote = null;
    this.abortController = controller;
    this.streamingId = messageId;
    this.streamingConversationId = conversationId;
    /*
     * 新一轮开始 → 上一条"等你继续"的邀请作废
     *
     * 用户已经开始处理别的事了，那个按钮留着只会让他怀疑"到底哪条在等我"。
     */
    this.continuableId = null;
    // 交接：从这里开始由 `streamingId` 负责"有人在生成"，占位可以放下了
    this.replyInFlight = false;
    this.emit();

    const specs = this.tools.specs();
    /** 已收工的轮次留下的段：正文 + 工具调用 + 工具结果。顺序即事实，只追加不改写 */
    const settled: MessageSegment[] = seed ? [...seed.segments] : [];

    let text = '';
    let reasoning = '';
    let usage: TokenUsage | undefined;
    let finishReason: FinishReason = 'stop';
    let failure: AppError | null = null;
    let lastFlush = 0;
    let lastPersist = startedAt;
    let hitRoundLimit = false;
    let hitContinuationLimit = false;
    /** 续写中途上下文到顶，主动收在上一轮（见轮次循环里的判断） */
    let hitContextLimit = false;
    /** 「每轮询问」：这是一次"停下来征求意见"，不是写完了（见下面判定处的说明） */
    let awaitingContinue = false;

    /*
     * ── 续写引擎（M2）──
     *
     * 【它解决什么】单次请求受 max_tokens 硬限制（约几千汉字），
     * 写长文必然被截断。引擎的做法是：模型停下来时检查字数，
     * 没到下限就带着续写指令再来一轮，**全部内容累积在同一条消息里**。
     *
     * 【什么情况才算"写完了"】必须同时满足两条：
     *  1. 模型**自然结束**（finish_reason 是 stop，而不是被 max_tokens 截断）；
     *  2. 字数到了下限。
     * 只有其一都不算 —— 被截断的结尾是断的；没到字数就收尾是偷懒。
     *
     * 【不会无限跑】三道闸：
     *  - 软上限（下限 × 系数）：到了就停，宁可少一点也不为凑字数跑飞；
     *  - 停顿检测：连续 N 轮没产出新内容（模型原地打转）就中止；
     *  - 硬性轮数上限。
     */
    const continuationActive =
      config.continuation !== 'off' && config.writingMode !== 'chat' && config.minOutputChars > 0;
    /*
     * 「每轮询问」：该续写**但不由它自己决定**
     *
     * 这一档此前是空转的 —— 界面给了三个选项，而 `continuationActive` 只区分
     * "是不是 off"，于是"每轮询问"与"自动续写"跑的是同一段逻辑，
     * 用户设了也看不出区别（真实反馈：`每轮询问` 没有效果）。
     * 现在它在这里分开：判定说"还能再写一轮"时，停下来把决定权交回用户。
     */
    const askEachRound = continuationActive && config.continuation === 'ask';
    const targetChars = config.minOutputChars;
    const softMaxChars = config.softMaxChars;
    const stallLimit = Math.max(1, config.stallLimit);

    /*
     * 续写轮与普通对话用**同一组采样参数**
     *
     * 早先续写有一个档位专属的 `maxTokensPerRequest`，与采样里的 `max_tokens` 并存 ——
     * 同一个"一次最多写多少"要在两处填，用户还得猜哪个在生效（真实反馈）。
     * 现在统一成「单轮输出上限」= `sampling.maxTokens`，界面在 设置 → 上下文，
     * 普通对话与短/中/长三个档位共享它。
     */

    /** 已累计的正文（含已固化轮次）。思考过程不算字数 —— 用户要的是正文 */
    const charsSoFar = (): number => {
      let total = text.length;
      for (const segment of settled) {
        if (segment.kind === 'text') total += segment.text.length;
      }
      return total;
    };
    let stallCount = 0;
    let lastCharCount = 0;
    let continuationRounds = 0;

    /*
     * 轮次循环（ReAct）
     *
     * 一轮 = 一次完整的流式请求。若模型在结尾要求调用工具，就执行它们、
     * 把结果并进消息，再来一轮 —— 直到模型不再要求调用工具（正常收尾）、
     * 出错、被中止，或者撞上轮数上限。
     *
     * 轮数上限是**必须的**：模型偶尔会陷入"读一下、再读一下"的循环，
     * 没有上限就会一直烧 token 且界面永远不停。
     */
    for (let round = 0; ; round += 1) {
      const calls: ToolCall[] = [];

      try {
        /*
         * ── 轮间：上下文按**与发送前同一套规矩**处理 ──
         *
         * 续写（以及工具轮）是在同一条消息里一轮轮往下发，而发送前那道闸门只管第一次。
         * 所以这里每轮都自查一次：
         *  - 到压缩触发线、且开了自动压缩 → **压一次再接着写** —— 长文写到一半顶到线时
         *    不必停下来等用户手动压（这正是"长档写不完"的根因）；
         *  - 压不了或者超过预算 → 落到下面那段判断：停在上一轮，并把下一步说清楚。
         *
         * 【为什么这里可以压缩，而界面上的按钮在生成中会被拒】
         * 两个前提缺一不可：此刻**没有正在传输的请求**（上一轮的流已经读完），
         * 而且**正在写的这条消息压不到** —— `planCompression` 硬性保留最近一轮，
         * 压的只是更早的对话历史。所以"一个气泡连续写"的体验不会被破坏。
         * 破例之后必须重算纪要/历史（见下面），这与 `contextManager.compress` 的约定一致。
         *
         * 只在"当前会话仍是它"时做：用户可能已经切走，而压缩作用在**激活会话**上。
         */
        if (round > 0 && this.activeId === conversationId) {
          const used = this.context.status().usedTokens;
          /*
           * 这里与 `shouldAutoCompress` 有**一处刻意的差别**：不排除"已经超预算"的情形
           *
           * 那道谓词里写着"已经超限时不再自动压，而是走闸门拦住，让用户自己决定" ——
           * 那是**发送前**的语义：用户就坐在键盘前，拦住他并说清楚是更好的选择。
           * 而轮间是**生成正在进行中**，没有"让用户点一下"的间隙：要么压完接着往下写
           *（这正是自动压缩在长文里的意义），要么就干净地停下（下面那段判断）。
           * 所以这里用"到触发线就压"，压不动时自然落回"停下并说清楚"。
           */
          const atCompressionLine =
            config.compression === 'auto' &&
            config.contextBudget > 0 &&
            used >= config.contextBudget * config.compressAt;
          if (atCompressionLine) {
            const compressed = await this.context.compress({ allowWhileStreaming: true });
            if (compressed.ok) {
              summaryText = activeSummaryOf(this.getConversationById(conversationId))?.text ?? null;
              history = buildHistory();
              promptText = serializePrompt(history);
              this.lastPromptByConversation.set(conversationId, promptText);
            }
          }
        }

        /*
         * 这一轮发什么，交给 `buildRoundRequest`
         *
         * 它把三件事一次做对（工具往来先入列、续写指令在预算前入列、没工具就不发工具字段），
         * 每轮重算 —— 工具结果与续写段都会把上下文顶起来，第二轮的预算和第一轮不一样。
         */
        const roundPlan = buildRoundRequest({
          history,
          settled,
          round,
          continuationActive,
          continuationPrompt: config.continuationPrompt,
          params: config.params,
          tools: specs,
          contextBudget: config.contextBudget,
          // 连接信息来自**解析后的模型配置**（会话 → 角色 → 全局当前），
          // 适配器不自己去读设置，因此它是无状态的
          connection: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            requestTimeoutMs: config.requestTimeoutMs,
            extraBodyJson: config.extraBody,
            model: config.model,
          },
          signal: controller.signal,
        });
        this.contextNote = roundPlan.contextNote;

        /*
         * 续写轮间：上下文已超上限 → **停在这里，不发这一轮**
         *
         * 这是**压不动时的兜底**：每一轮开头的那段自查会先试着压一次（开了自动压缩时），
         * 压成了就接着写、到不了这里；只有"没开自动压缩"或"没有可压的历史了"才会落到这。
         * 此时"超了还照发"是拿一次**可能被上游拒绝**的请求去赌：赌输了，上游的错误文案会被
         * `appendFailure` 追进正文，用户在自己写的小说里读到一段报错 —— 那是最坏的一种收场。
         * 所以把闸门的规矩**沿用到底**：压不了就停，并把"下一步能做什么"说清楚
         *（与工具轮上限、续写轮数上限同一套做法）。
         *
         * 只在 `round > 0` 时判：第 0 轮已经过了发送前那道闸门，这里再判一次没有意义。
         */
        if (round > 0 && roundPlan.overBudgetTokens > 0) {
          hitContextLimit = true;
          break;
        }

        const stream = this.provider.streamChat(roundPlan.request);

        for await (const event of stream) {
          if (event.kind === 'error') {
            failure = event.error;
            break;
          }

          switch (event.kind) {
            case 'delta':
              text += event.text;
              break;
            case 'reasoning':
              reasoning += event.text;
              break;
            case 'tool_call':
              calls.push(event.call);
              break;
            case 'usage':
              // 多轮累加：界面上这只是一条消息，用量就该是它的总量
              usage = addUsage(usage, event.usage);
              break;
            case 'done':
              finishReason = event.finishReason;
              break;
          }

          const now = Date.now();
          if (now - lastFlush < STREAM_FLUSH_MS) continue;
          lastFlush = now;

          this.applyStreamContent(conversationId, messageId, text, reasoning, now, settled);

          if (now - lastPersist >= STREAM_PERSIST_MS) {
            lastPersist = now;
            void this.persistMessage(conversationId, messageId);
          }
        }
      } catch (error) {
        failure = toAppError(error, '生成过程中发生未知错误');
      }

      if (failure || controller.signal.aborted) break;

      /* ── 出路一：有工具调用 → 固化、执行、再来一轮 ── */
      if (calls.length > 0) {
        /*
         * 工具轮的编排（固化顺序、轮数上限、中止时不再执行）都在 `runToolRound` 里，
         * 依赖用窄接口注入 —— 那些规则属于"顺序与时机"，很容易被一次无关的重构改坏，
         * 所以单独成模块、单独有用例。
         */
        const outcome = await runToolRound(
          { calls, reasoning, text, settled, atRoundLimit: round >= MAX_TOOL_ROUNDS - 1 },
          {
            run: (call) => this.tools.run(call),
            show: (segments) => {
              this.applyStreamContent(conversationId, messageId, '', '', Date.now(), segments);
              this.emit();
            },
            persist: () => void this.persistMessage(conversationId, messageId),
            aborted: () => controller.signal.aborted,
          },
        );

        if (outcome.kind === 'round-limit') {
          // 撞上限要和"写完了"区分开：下面会补一句"还能再要一轮"
          hitRoundLimit = true;
          break;
        }

        // 本轮产出已固化进 `settled`，下一轮从空白开始
        text = '';
        reasoning = '';
        /*
         * 用户在中途按了停止：**不再发起新请求**
         *
         * 早先这里是无条件 `continue`，于是下一轮照样组装、并带着已中止的信号发出去 ——
         * 服务端那边已经取消了，这一趟往返纯属白跑（探针验过：停止后请求数会从 1 变成 2）。
         * 收尾逻辑本来就会按 `aborted` 处理。
         */
        if (outcome.aborted) break;
        continue;
      }

      /* ── 出路二：没有工具调用 → 该收尾了，或者该续写了 ── */
      const chars = charsSoFar();

      // 停顿计数：连续几轮没产出新内容 = 模型在原地打转，再续也是浪费
      if (chars > lastCharCount) {
        stallCount = 0;
        lastCharCount = chars;
      } else {
        stallCount += 1;
      }

      const decision = decideContinuation({
        active: continuationActive,
        chars,
        targetChars,
        softMaxChars,
        finishReason,
        stallCount,
        stallLimit,
        rounds: continuationRounds,
        maxRounds: MAX_CONTINUATION_ROUNDS,
      });

      if (decision.kind === 'stop') {
        // 撞上限要和"写完了"区分开：前者要让用户知道还能再要
        if (decision.reason === 'round-limit') hitContinuationLimit = true;
        break;
      }

      /*
       * 「每轮询问」：到此为止，等用户点一次头
       *
       * 判定说"还能再写一轮"，但这一档把决定权交回用户 —— 界面会在这条消息下
       * 长出一个「继续写」按钮（见快照的 `continuableMessageId`）。
       *
       * 这里**不固化本轮**：用户可能就此打住，而收尾逻辑本来就会把这轮产出
       * 正常写进段落（`finalizeStream` 是唯一出口），所以"停下来"不会丢内容，
       * 也不会让这条消息看起来像"写了一半崩了"。
       */
      if (askEachRound) {
        awaitingContinue = true;
        break;
      }
      continuationRounds += 1;

      /*
       * 固化本轮，带着续写指令再来一轮
       *
       * 注意**没有任何新消息节点**：续写的内容全部累积在同一条消息里，
       * 界面上就是一个气泡连续往下写 —— 这是"连续感"的来源。
       */
      if (reasoning.length > 0) settled.push({ kind: 'reasoning', text: reasoning });
      if (text.length > 0) settled.push({ kind: 'text', text });
      text = '';
      reasoning = '';
      this.applyStreamContent(conversationId, messageId, '', '', Date.now(), settled);
      this.emit();
    }

    if (hitRoundLimit) {
      text += `\n\n（已连续调用工具 ${MAX_TOOL_ROUNDS} 轮，先停在这里。说一声「继续」我就接着做。）`;
    }
    if (hitContinuationLimit) {
      text += `\n\n（续写轮数达到上限，先停在这里。说一声「继续」我就接着往下写。）`;
    }
    if (hitContextLimit) {
      /*
       * 说的必须是**用户能做的下一步**，而不是"上下文超限"这种他没法处理的话
       *
       * 与发送前那道闸门给的建议保持一致（压缩一次 / 调大上限），
       * 这样两条路径遇到同一件事时说法相同 —— 用户学一次就够了。
       */
      text +=
        `\n\n（上下文已到设定上限，先停在这里 —— 再往下发可能被接口拒绝。` +
        `点顶栏右侧的上下文按钮压缩一次，或把「上下文长度」调大，然后说一声「继续」我就接着写。）`;
    }

    const aborted = controller.signal.aborted;
    this.abortController = null;
    this.streamingId = null;
    this.streamingConversationId = null;
    /*
     * 挂上"等你继续"（只有真的停在"还能再写一轮"时才挂）
     *
     * 中止的不算：用户刚按了停止，再问一句"要不要继续"是反着来的。
     */
    this.continuableId = awaitingContinue && !aborted ? messageId : null;

    await this.finalizeStream({
      conversationId,
      messageId,
      text,
      reasoning,
      usage,
      finishReason,
      failure,
      aborted,
      previousPrompt,
      promptText,
      settled,
    });
  }

  /** 只更新内存并通知界面（不落库）——每次 flush 走这条路 */
  private applyStreamContent(
    conversationId: ConversationId,
    messageId: MessageId,
    text: string,
    reasoning: string,
    now: number,
    settled: readonly MessageSegment[] = [],
  ): void {
    const tree = this.threads.get(conversationId);
    if (!tree) return;

    this.threads.set(conversationId, {
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === messageId
          ? withStreamedContent(node, text, reasoning, now, settled)
          : node,
      ),
    });
    this.emit();
  }

  private async persistMessage(conversationId: ConversationId, messageId: MessageId): Promise<void> {
    const node = this.threads
      .get(conversationId)
      ?.nodes.find((item) => item.id === messageId);
    if (node) this.notePersistence(await this.messages.save(node));
  }

  /**
   * 记下（或清掉）"内容没落库"这件事
   *
   * 成功的写会**清掉**它：这是一条"当前状态"，不是历史记录。流式期间会周期性落库，
   * 一次抖动下一次就补上了，提示不该一直留着；只有真的持续写不进去时才挂在界面上 ——
   * 那正是需要用户知道（并去腾出空间）的情形。
   */
  private notePersistence(result: Result<void>): void {
    const message = result.ok ? null : `内容没能保存到本地：${result.error.message}`;
    if (message === this.persistenceError) return;
    this.persistenceError = message;
    this.emit();
  }

  private async finalizeStream(input: {
    conversationId: ConversationId;
    messageId: MessageId;
    text: string;
    reasoning: string;
    usage: TokenUsage | undefined;
    finishReason: FinishReason;
    failure: AppError | null;
    aborted: boolean;
    previousPrompt: string;
    promptText: string;
    /** 前面几轮留下的段（正文 + 工具调用 + 工具结果） */
    settled: readonly MessageSegment[];
  }): Promise<void> {
    const tree = this.threads.get(input.conversationId);
    const existing = tree?.nodes.find((item) => item.id === input.messageId);
    if (!tree || !existing) return;

    /*
     * 注："只出了思考、正文是空的"要说明、"用户停止不是错误"这两条规则
     * 都在 `classifyStreamOutcome` 里（连同"判断有没有正文要连 settled 一起看"）——
     * 它们以前写在这里，属于"改错一次就把错误写进用户正文"的那一类，已抽出并单独有用例。
     */

    /*
     * "算成功、算失败、还是用户按了停止"交给 `classifyStreamOutcome`
     *
     * 这里是最后一道容易写错的地方（把错误写进用户的正文本就回不去了），
     * 三条规则都在那个纯函数里，单独有用例钉住。
     */
    const { body, status, finishReason } = classifyStreamOutcome({
      text: input.text,
      reasoning: input.reasoning,
      settled: input.settled,
      finishReason: input.finishReason,
      failure: input.failure,
      aborted: input.aborted,
    });

    const usage = resolveUsage(input.usage, input.previousPrompt, input.promptText, input.text);

    const streamed = withStreamedContent(existing, body, input.reasoning, Date.now(), input.settled);
    const next: MessageNode = {
      ...streamed,
      /*
       * 定稿时不留**空文本段**
       *
       * `withStreamedContent` 总会追加一个文本段 —— 那是流式期间"打字的位置"，是对的；
       * 但一条消息定稿时如果正文是空的（最典型：用户正好停在工具调用上，还没有正文），
       * 那一段会永久留在消息里：界面上它是一个**空的彩色气泡**（`.bubble` 有内边距与背景），
       * 落库与导出里也多一段空内容。定稿是最后一个能收拾它的时机。
       */
      segments: streamed.segments.filter(
        (segment) => segment.kind !== 'text' || segment.text.length > 0,
      ),
      status,
      finishReason,
      ...(usage ? { usage } : {}),
    };

    this.threads.set(input.conversationId, {
      ...tree,
      nodes: tree.nodes.map((item) => (item.id === input.messageId ? next : item)),
    });
    this.emit();

    this.notePersistence(await this.messages.save(next));
  }

  async editMessage(id: MessageId, text: string, mode: EditSubmitMode): Promise<Result<void>> {
    const conversation = this.getActiveConversation();
    const tree = this.getActiveTree();
    const node = tree.nodes.find((item) => item.id === id);
    if (!node) return ok(undefined);

    /*
     * AI 回复的"保存并发送"= 原地改。
     *
     * 因为对 AI 回复来说，"另存为一个变体"与"重生成"是同一件事，
     * 而重生成已经有独立按钮了。编辑框只承担"改错别字"这一种意图，
     * 界面因此只给「取消 / 保存」两个按钮，这里也照此处理（而不是留着不用的分支逻辑）。
     */
    if (mode === 'save' || node.role !== 'user') {
      return this.commit(conversation.id, withNodeTextPatched(tree, id, text, Date.now()));
    }

    // ── 编辑用户提问 + 重新发送 ──
    // 必须**同时重新生成回答**：只换提问而不重新回答，用户会以为"点了没反应"
    // （新提问下面一片空白，旧回答被留在了旧分支里）。
    return this.exclusiveReply(() => this.resendEdited(id, text));
  }

  /**
   * 编辑用户提问后重发
   *
   * 原提问**一字不动**，新提问作为它的**兄弟**进入同一个变体组 ——
   * 旧回答因此整条留在旧分支里。这正是"编辑即分支"：改过的版本是并列，不是替换。
   * 并发占位由 `editMessage` 负责（见 exclusiveReply）。
   */
  private async resendEdited(id: MessageId, text: string): Promise<Result<void>> {
    // 闸门要在最前面：它可能触发压缩，而压缩会改标记与会话行
    const ready = await this.context.prepare(text);
    if (!ready.ok) return ready;

    const { conversation, tree, config } = ready.data;
    const node = tree.nodes.find((item) => item.id === id);
    if (!node) return ok(undefined);

    const index = cachedTreeIndex(tree.nodes);
    const siblings = index.childIdsOf.get(node.parentId) ?? [];

    const edited = createNode({
      conversationId: conversation.id,
      parentId: node.parentId,
      role: 'user',
      text,
      // 与原提问并列，因此变体序号取兄弟数量
      variantIndex: siblings.length,
      now: Date.now(),
    });

    const next = withNodeAdded(tree, edited);
    // 与 send() 同一条规则：标题还停在默认值才自动起名，用户改过就绝不碰。
    // 之前这里是**无条件**覆盖 —— 编辑任何一条消息都会把标题改成那条的文本，
    // 于是标题看起来"变成了最后一句"。
    const committed = await this.commit(
      conversation.id,
      next,
      conversation.title === DEFAULT_CONVERSATION_TITLE
        ? { title: deriveTitleFromText(text) }
        : {},
    );
    if (!committed.ok) return committed;

    return this.spawnReply(conversation, next, edited.id, config);
  }

  async deleteMessage(id: MessageId): Promise<Result<void>> {
    /*
     * 同步路径：会话与树是**同一时刻**取到的，再立刻提交，中间没有 await，
     * 因此不存在"切了会话却把树写到别处"的窗口（与 `send` 那条路不同）。
     *
     * 删的是**这一条**：后面的消息接到它前面那条上，不会跟着消失
     * （语义与理由见 `withNodeRemoved`）。
     */
    const conversation = this.getActiveConversation();
    /*
     * 删掉的正好是"等你继续"的那条 → 邀请一并作废
     *
     * 不清的话界面上会留着一个按钮指向不存在的消息（点了没反应），
     * 而那看起来完全像个 bug。
     */
    if (this.continuableId === id) this.continuableId = null;
    return this.commit(
      conversation.id,
      withNodeRemoved(this.getActiveTree(), id, Date.now()),
    );
  }

  async regenerate(id: MessageId): Promise<Result<void>> {
    return this.exclusiveReply(() => this.regenerateNow(id));
  }

  /** `regenerate` 的实际内容；并发占位由 `regenerate` 负责（见 exclusiveReply） */
  private async regenerateNow(id: MessageId): Promise<Result<void>> {
    // 重生成会再发一次请求，同样要过闸门（它可能触发压缩）
    const ready = await this.context.prepare('');
    if (!ready.ok) return ready;

    const { conversation, tree, config } = ready.data;
    const node = tree.nodes.find((item) => item.id === id);
    if (!node || node.role !== 'assistant') return ok(undefined);

    const index = cachedTreeIndex(tree.nodes);
    const group = (index.childIdsOf.get(node.parentId) ?? [])
      .map((childId) => tree.nodes.find((item) => item.id === childId))
      .filter((candidate) => candidate && candidate.variantOf === node.variantOf);

    // 重生成 = 在**同一个变体组**里再要一个版本，原回答一字不动地留着
    const regenerated = createNode({
      conversationId: conversation.id,
      parentId: node.parentId,
      role: 'assistant',
      text: '',
      status: 'streaming',
      variantOf: node.variantOf,
      variantIndex: group.length,
      now: Date.now(),
      modelRef: config.model || node.modelRef || null,
      paramsSnapshot: config.params,
    });

    const next = withNodeAdded(tree, regenerated);
    const committed = await this.commit(conversation.id, next);
    if (!committed.ok) return committed;

    void this.runStream(conversation.id, regenerated.id, next, config, Date.now());
    return ok(undefined);
  }

  async continueWriting(id: MessageId): Promise<Result<void>> {
    return this.exclusiveReply(() => this.continueNow(id));
  }

  /**
   * `continueWriting` 的实际内容；并发占位由 `continueWriting` 负责
   *
   * 只服务「每轮询问」那一档：用户看完这一轮，点了「继续写」。
   *
   * 与 `regenerate` 的关键区别是**不新建消息** —— 接着往同一条里写。
   * 新建的话"一个气泡连续写"的观感就断了，用户还会莫名多出一条半截回复。
   */
  private async continueNow(id: MessageId): Promise<Result<void>> {
    // 与 regenerate 同一条纪律：它也要发请求，就得先过上下文闸门（可能触发压缩）
    const ready = await this.context.prepare('');
    if (!ready.ok) return ready;

    const { conversation, tree, config } = ready.data;
    const node = tree.nodes.find((item) => item.id === id);
    if (!node || node.role !== 'assistant') return ok(undefined);

    /*
     * 把这条消息**已有的段**交回去当"已定稿的轮次"
     *
     * 那些段就是它走到现在为止的全部事实（正文 + 工具往来）。交回去之后，
     * 拼出来的请求与上一轮**逐字节一致**：模型看到的是"我刚写到一半"，
     * 而不是"从头再写一遍"，前缀缓存也照旧命中。
     */
    void this.runStream(conversation.id, node.id, tree, config, Date.now(), {
      segments: node.segments,
    });
    return ok(undefined);
  }

  async selectVariant(id: MessageId, delta: number): Promise<Result<void>> {
    const tree = this.getActiveTree();
    const node = tree.nodes.find((item) => item.id === id);
    if (!node) return ok(undefined);

    const target = shiftVariant(cachedTreeIndex(tree.nodes), node, delta);
    if (!target) return ok(undefined);

    // 同步路径，理由同 deleteMessage
    const conversation = this.getActiveConversation();
    return this.commit(conversation.id, withActiveChild(tree, node.parentId, target.id));
  }

  /* ────────────────────────── 内部 ────────────────────────── */

  private getActiveConversation(): Conversation {
    const found = this.conversations.find((item) => item.id === this.activeId);
    if (found) return found;

    const first = this.conversations[0];
    if (first) {
      this.activeId = first.id;
      return first;
    }
    return SAFETY_CONVERSATION;
  }

  private getActiveTree(): TreeState {
    const id = this.activeId;
    if (id === null) return emptyTree();
    return this.threads.get(id) ?? emptyTree();
  }

  /** 首次进入某个会话时才查库 —— 列表切换不该把所有会话的消息都拉一遍 */
  private async loadTree(id: ConversationId | null): Promise<Result<void>> {
    if (id === null || this.threads.has(id)) return ok(undefined);

    const listed = await this.messages.listByConversation(id);
    if (!listed.ok) return listed;

    const conversation = this.conversations.find((item) => item.id === id);
    this.threads.set(id, {
      // 上次退出时可能正好有消息在生成，库里留着 streaming 状态。
      // 不修的话它会一直转圈，而且因为 streamingId 为 null，发送键也不是停止键 ——
      // 变成一条永远长不完的消息。这里统一降级为 aborted。
      nodes: listed.data.map((node) =>
        node.status === 'streaming'
          ? { ...node, status: 'aborted' as MessageStatus, finishReason: 'aborted' as FinishReason }
          : node,
      ),
      activeRootChildId: conversation?.activeRootChildId ?? null,
    });
    return ok(undefined);
  }

  private persistConversation(next: Conversation): Promise<Result<void>> {
    this.replaceConversation(next, false);
    this.emit();
    return this.store.save(next);
  }

  /* ────────────────────────── 上下文压缩 ────────────────────────── */

  /** 手动压缩一次（顶栏的按钮走这里）。实现见 contextManager.ts */
  async compressContext(): Promise<Result<ContextCompressionReport>> {
    return this.context.compress();
  }




  /**
   * 正文搜索（跨会话）
   *
   * 三步，顺序就是"从便宜到昂贵"：
   *  1. **粗筛**：交给 SQLite 用 LIKE 把绝大多数行挡在内存之外，只回传候选行；
   *  2. **轻查**：只取命中会话的**连接关系**（三列，不读正文），算出各自
   *     当前可见的是哪条路径；
   *  3. **精判**：应用层的纯函数在可见路径上逐处定位命中（含片段与第几处）。
   *
   * 第 2 步是这套做法能成立的关键。旧分支（编辑、"重新生成"留下的）仍在库里，
   * 只做第 1 步会把它们当成结果返回 —— 用户按"下一处"只会跳到一片空白上。
   * 而判断"一个节点在不在当前分支上"只需要指针，不需要正文：
   * 把每个命中会话的正文全读进内存再走一遍路径，是这里最容易被写出的浪费。
   */
  async searchMessages(query: string): Promise<Result<MessageSearchHit[]>> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return ok([]);

    const candidates = await this.messages.findCandidates(trimmed, CANDIDATE_LIMIT);
    if (!candidates.ok) return candidates;
    if (candidates.data.length === 0) return ok([]);

    /*
     * 命中的会话按**最近使用**排（与侧栏顺序一致），会话内按上下顺序 ——
     * 于是"下一处"走下来是：从最近的对话开始，每条会话从上往下。
     */
    const matched = new Set(candidates.data.map((node) => node.conversationId));
    // 与侧栏同一套顺序（手动序优先），否则"搜索结果的先后"和"列表里的先后"对不上
    const ordered = orderConversations(
      this.conversations.filter((conversation) => matched.has(conversation.id)),
    );

    const links = await this.messages.listLinks(ordered.map((conversation) => conversation.id));
    if (!links.ok) return links;

    const pathByConversation = new Map<string, MessageId[]>();
    for (const conversation of ordered) {
      const own = links.data.filter((link) => link.conversationId === conversation.id);
      pathByConversation.set(conversation.id, activePathIdsOf(own, conversation.activeRootChildId));
    }

    return ok(
      searchVisibleAcrossConversations(
        { candidates: candidates.data, pathByConversation },
        trimmed,
      ),
    );
  }


  /**
   * 提交一次消息树变更
   *
   * 顺序很关键：**先更新内存并通知界面（乐观），再落库**。
   * 用户点一下就要立刻看到结果，不该等 SQLite 往返。
   * 落库失败时把错误交给调用方提示，但**不回滚界面** —— 用户已经看到并依赖这个状态，
   * 回滚造成的困惑比"界面与库里短暂不一致"更大（与 SettingsService 同一套取舍）。
   */
  private async commit(
    conversationId: ConversationId,
    next: TreeState,
    patch: Partial<Conversation> = {},
  ): Promise<Result<void>> {
    /*
     * 这里**必须**用调用方捕获的会话 id，不能用"当前激活会话"
     *
     * `commit` 的调用点几乎都排在 `await` 之后（发一条消息要等两次落库），
     * 而 `next` 是**调用之前**基于当时那个会话的树算出来的。
     * 如果用户在中途切了会话，"当前激活会话"已经换成另一个 ——
     * 把旧的 `next` 写进去，等于把 A 的消息树覆盖到 B 上，还会连带覆盖 B 的会话行。
     * 这是真正会损坏数据的一类竞态（另一个会话静默变成你的上一段对话），
     * 所以宁可让每个调用点多传一个 id。
     */
    const conversation = this.conversations.find((item) => item.id === conversationId);
    // 会话有可能在等待期间被删掉（删除时不打断正在跑的生成）。
    // 此时它的树已随会话一起销毁，硬写回去只会凭空复活一个"已删除会话的消息"。
    if (!conversation) return ok(undefined);

    const previous = this.threads.get(conversationId) ?? emptyTree();

    this.threads.set(conversation.id, next);

    // 会话行需要同步「虚拟根当前选中分支」：根指针存在会话上，不在消息表里
    const merged: Conversation = {
      ...conversation,
      ...patch,
      activeRootChildId: next.activeRootChildId,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    // 会话有新内容时把它顶到列表最前（仅发消息这类"真的产生内容"的操作）
    this.replaceConversation(merged, patch.title !== undefined);
    this.emit();

    const changed = changedNodes(previous.nodes, next.nodes);
    if (changed.length > 0) {
      const savedNodes = await this.messages.saveMany(changed);
      if (!savedNodes.ok) return savedNodes;
    }
    return this.store.save(merged);
  }

  private replaceConversation(next: Conversation, resort: boolean): void {
    const index = this.conversations.findIndex((item) => item.id === next.id);
    if (index < 0) {
      this.conversations = [next, ...this.conversations];
      return;
    }

    const list = [...this.conversations];
    list[index] = next;
    /*
     * 只在"真的产生内容"时才重排列表。
     * 若每次改参数都重排，用户正在看的列表会在手底下跳动 —— 那比"顺序不完美"更烦人。
     */
    this.conversations = resort ? orderConversations(list) : list;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * 影响上下文预算的那两个设置项（见构造函数里的订阅）
 *
 * 拼成一个字符串比较：数值型字段之间用分隔符隔开，避免 "1000" + "8192" 与
 * "10008" + "192" 撞成同一个键（这种错只有在某天真的撞上时才会被发现）。
 */
function budgetKeyOf(settings: AppSettings): string {
  return `${settings.context.maxContextTokens}|${effectiveMaxOutput(settings.sampling)}`;
}


