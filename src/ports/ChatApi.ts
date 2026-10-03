import type { Conversation } from '@domain/entities/conversation';
import type { RolePreset } from '@domain/entities/rolePreset';
import type { TreeState } from '@domain/rules/messageTreeEdits';
import type { ConversationId, MessageId } from '@shared/ids';
import type { MessageSearchHit } from './repositories/MessageStore';
import type { Result } from '@shared/result';

/**
 * 编辑提交方式
 *
 * 两者是**语义不同**的两件事，不是"一个快一个慢"：
 *  - `save`：原地改文字，不产生新版本、不重发 —— 修错别字用；
 *  - `send`：编辑即分支 —— 新增变体/兄弟节点，原内容一字不改地保留。
 */
export type EditSubmitMode = 'save' | 'send';

/**
 * 生成过程中的阶段（界面据此自动展开 / 折叠「思考过程」与「文件工具」两块面板）
 *
 * 三态就够描述"现在在干什么"：
 *  - `reasoning`：正在吐思考链 → 展开思考框；
 *  - `tool`：正在准备或执行工具调用 → 展开工具框（"即将动你的文件"必须先露头）；
 *  - `text`：正在说正文 → 两块都折叠，把版面让给正文。
 *
 * 它**按轮更新**：一轮说正文、下一轮又开始调用工具，阶段就会回到 `tool`。
 * 这正是"中途再开始思考 / 使用工具都要自动展开"的实现方式。
 */
export type StreamPhase = 'reasoning' | 'text' | 'tool';

/** 界面上需要的一切会话状态，一次给全，避免多处订阅拼装出不一致的中间态 */
export interface ChatSnapshot {
  /** 全部未删除会话，按更新时间倒序 */
  conversations: Conversation[];
  activeId: ConversationId | null;
  /**
   * 当前会话。**保证非空**
   *
   * 聊天界面需要一个"落点"：没有会话时输入框往哪写？所以服务保证
   * 任何时候都存在一个可用的会话（删光了会自动开一个新的），
   * 界面因此完全不必写 null 判断。
   */
  conversation: Conversation;
  /** 当前会话的消息树 */
  tree: TreeState;
  /**
   * 正在流式生成的消息 id；null = 空闲
   *
   * 界面据此把发送键切成停止键 —— 用消息 id 而不是一个布尔，
   * 这样还能顺便知道"是哪条消息在长"，可以做局部高亮。
   */
  streamingMessageId: MessageId | null;
  /**
   * 正在生成的那条消息**此刻处于哪个阶段**（`null` = 现在没有在生成）
   *
   * 界面据此决定自动展开哪个面板：思考中展开思考框、执行工具时展开工具框、
   * 一开始说正文就两个都折叠。
   *
   * 【为什么是"当前阶段"而不是消息上的字段】它描述的是**此刻**。写进消息就得迁移，
   * 而且会给历史消息留下一个毫无意义的"最后停在哪个阶段"—— 翻旧对话时每条老消息
   * 的展开状态都不一样，版面会很跳。
   *
   * 【为什么 `text` 也当成一个阶段】只区分"思考 / 工具"是不够的：正文明明在往外写，
   * 面板却还开着，用户就得一边读一边看过程。说正文是上面两条的**终止条件**。
   */
  streamPhase: StreamPhase | null;
  /**
   * 「每轮询问」档位下，那条**正等着用户点头**的回复（`null` = 没有）
   *
   * 界面据此在那条消息下面显示「继续写」。它是**当前状态**而不是消息属性，
   * 因此不落库：重启应用后按钮不会回来 —— 想接着写，打一个「继续」发出去
   * 同样做得到，而为一个"临时邀请"加一列数据不值得。
   */
  continuableMessageId: MessageId | null;
  /**
   * 内容没能写进本地库（`null` = 没问题）
   *
   * 与命令返回的错误是两件事：那是"这次操作没成功"，这个是"界面看着一切正常，
   * 但内容其实没落库"—— 后者只有在重开页面时才会暴露，所以必须单独送到用户眼前。
   * 写入恢复正常会自己清掉（它是当前状态，不是历史）。
   */
  persistenceError: string | null;
  /**
   * 最近一次请求为塞进上下文做过什么（`null` = 什么都没做）
   *
   * 它不是日志，而是**必需的用户可见信息**：一旦裁剪真的发生，
   * 发出去的内容就与屏幕上看到的不完全一样了。不告诉用户的话，
   * "模型怎么忘了我前面说的话"会变成一个无解的谜题。
   */
  contextNote: string | null;
  /**
   * 上下文状态（**每次快照现算**，不是存下来的）
   *
   * 之所以坚持现算：这三个数必须始终等于"下一次请求会怎样"。
   * 一旦改成"上次算完存起来"，就会出现"用户把上限调回去了、顶栏还写着已压缩"
   * 这种自相矛盾的显示 —— 而且越是改设置的人越容易撞上。
   */
  context: {
    /** 下一次请求预计占用（只算真正会发出去的部分） */
    usedTokens: number;
    budget: number;
    ratio: number;
    summaryCount: number;
    summaryTokens: number;
    lastCompressedAt: number | null;
    /** true = 已超上限，必须先压缩才能继续对话 */
    blocked: boolean;
  };
  /** 正在压缩（界面显示进行中，并拦住并发操作） */
  compressing: boolean;
}

/** 一次压缩的结果（用于给用户一句明确的反馈） */
export interface ContextCompressionReport {
  /** 被压成纪要的消息条数 */
  coveredCount: number;
  /** 压缩前这些内容占的 token */
  beforeTokens: number;
  /** 纪要占的 token */
  afterTokens: number;
}

/**
 * 会话与消息树的对外契约
 *
 * 分层意图：**全部业务编排在这里，UI store 只做镜像**。
 * 这样"发送、编辑即分支、级联删除、持久化"都能脱离 React 单测，
 * 换 UI 框架时一行不用改。
 */
export interface ChatApi {
  snapshot(): ChatSnapshot;
  isLoaded(): boolean;
  load(): Promise<Result<void>>;
  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void;

  /* ── 会话列表 ── */

  /** 用某个角色预设开一场新对话（role 为 null 则是空白会话） */
  create(role: RolePreset | null): Promise<Result<Conversation>>;
  /** 切换当前会话；首次进入该会话时才会去查它的消息 */
  select(id: ConversationId): Promise<Result<void>>;
  /** 删除会话（软删除；若删的是当前会话会自动切到下一个） */
  remove(id: ConversationId): Promise<Result<void>>;
  rename(id: ConversationId, title: string): Promise<Result<void>>;
  /**
   * 把一条会话导出成 Markdown 文本
   *
   * 只管生成文本：挑文件、写文件是调用方（界面）的事 —— 这样"哪些内容该进导出"
   * 这条规则留在 domain，而"存哪儿"留在宿主。
   * **不会切换当前会话**：用户可能只是想在列表里随手存一条。
   */
  exportConversation(id: ConversationId): Promise<Result<string>>;
  /** 修改当前会话的任意字段（会话设置面板用；未改的字段保持继承语义） */
  updateActive(patch: Partial<Conversation>): Promise<Result<void>>;
  /** 用最新版角色预设覆盖当前会话的角色实例（用户点「重新同步」） */
  resyncRole(role: RolePreset): Promise<Result<void>>;

  /* ── 消息树 ── */

  send(text: string): Promise<Result<void>>;
  /** 中止当前生成；已产出的内容会保留，状态标记为 aborted */
  stop(): void;
  editMessage(id: MessageId, text: string, mode: EditSubmitMode): Promise<Result<void>>;
  deleteMessage(id: MessageId): Promise<Result<void>>;
  regenerate(id: MessageId): Promise<Result<void>>;
  /**
   * 接着往下写（「每轮询问」档位下那个「继续写」按钮走这里）
   *
   * 与 `regenerate` 的关键区别：**不新建消息** —— 新内容继续累积在同一条里，
   * 界面上还是一个气泡连续往下写。
   */
  continueWriting(id: MessageId): Promise<Result<void>>;
  /** 在变体组内左右切换（delta = ±1） */
  selectVariant(id: MessageId, delta: number): Promise<Result<void>>;

  /* ── 上下文压缩 ── */

  /**
   * 把较早的历史压缩成一段纪要（顶栏上下文菜单里的按钮）
   *
   * 手动触发而不是自动：压缩要花一次模型调用，还会改写发出去的内容 ——
   * 用户点了才做，是这个功能唯一诚实的默认。
   */
  compressContext(): Promise<Result<ContextCompressionReport>>;

  /* ── 搜索 ── */

  /**
   * 按**正文**搜索（标题搜索在界面层本地做，不必过数据库）
   *
   * 返回"命中"而不是"会话列表"：端口给出原始事实，怎么呈现留给界面 ——
   * 既可以按会话汇总（"3 个会话命中"），也可以直接列出命中片段。
   */
  searchMessages(query: string): Promise<Result<MessageSearchHit[]>>;

  /* ── 排序 ── */

  /**
   * 手动排序
   *
   * 传的是**当前可见顺序**的 id 列表；没在列表里的会话保持原编号不动。
   * 顺序写进会话行本身（`sort_order`），所以备份/导出会带上它。
   */
  reorderConversations(orderedIds: ConversationId[]): Promise<Result<void>>;
}
