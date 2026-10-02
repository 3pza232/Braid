import type { ConversationId, MessageId, RoleId } from '@shared/ids';
import type { RoleInstance } from '@domain/entities/roleInstance';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { WritingMode } from '@domain/value-objects/writingMode';

/** 分支溯源信息：这条会话是从哪条会话的哪个节点分出去的 */
export interface ForkOrigin {
  conversationId: ConversationId;
  messageId: MessageId;
}

export interface Conversation {
  id: ConversationId;
  title: string;

  /**
   * 会话级工作区（已确认 Q-F2）
   *
   * 在「聊天前选择目录」，每个会话绑定一个目录，不同会话可指向不同项目。
   * 越界访问一律直接拒绝，不做多挂载点（Q3）。
   */
  workspaceRoot: string | null;

  /**
   * 本会话是否允许 AI 编辑工作区文件：`null` = 继承全局设置
   *
   * 用 `null` 而不是 `false` 表示"没表态"：否则全局开关打开时，
   * 所有会话都会因为自己是 `false` 而不生效。
   */
  allowWorkspaceEdit: boolean | null;

  /**
   * 角色实例（创建会话时从角色预设快照下来，之后只读）
   *
   * 会话**不直接引用**角色预设，因为那样"改一次角色会串改所有历史对话"。
   * 用户点「重新同步」才会用最新预设覆盖它。
   */
  roleInstance: RoleInstance | null;
  /** 来源角色 id，仅用于追溯 */
  roleId: RoleId | null;

  /**
   * ── 会话级覆盖（三层优先级的最高层：全局默认 → 角色预设 → 会话覆盖）──
   *
   * 全部用「null / 空值 = 继承上一层」的语义，而不是复制一份值进来。
   * 这样用户改了角色预设或全局默认后，没有显式覆盖过的会话会自动跟随，
   * 不会出现"N 个会话各自冻结着一份旧参数"的僵硬状态。
   */
  /**
   * 用哪一份「模型配置」（端点 + 凭据 + 余额）
   *
   * null = 继承角色实例 → 全局当前配置。与下面的 `model` 是两件事：
   * 配置决定"打到哪个端点、用哪个 Key"，`model` 只是可选的模型名覆盖。
   */
  modelProfileId: string | null;
  /** 模型名覆盖；null = 用配置里写的那一个 */
  model: string | null;
  /** 采样参数；只写用户在本会话里显式改过的字段 */
  params: SamplingParams;
  /** 预设词（系统提示词）；null = 继承角色预设 */
  systemPrompt: string | null;
  /** 输出档位；'chat' = 普通对话，其余为续写模式的短/中/长 */
  writingMode: WritingMode | 'chat';
  /** 本会话的字数下限覆盖；null = 用全局档位预设里的值 */
  minOutputChars: number | null;
  /** 本会话的续写提示词覆盖；null = 用全局档位预设里的值 */
  continuationPrompt: string | null;
  /**
   * 本会话"至少保留最近多少轮原文"的覆盖；null = 继承全局设置
   *
   * 为什么可以覆盖而上下文上限不可以：上限是**这台机器/这份配置**的性质
   * （取决于你给模型留了多大的窗口），一个会话改它没有意义，只会造成
   * "这个会话莫名其妙不能聊了"。而"保留多少轮原文"是**这场对话**的性质 ——
   * 写小说与问代码，想留住的历史长度本来就不同。
   */
  keepRecentMessages: number | null;
  /** 本会话里 AI 的名字；null = 继承角色 / 全局 */
  assistantName: string | null;
  /** 本会话里对用户的称呼；null = 继承角色 / 全局 */
  userName: string | null;

  /**
   * 根层的"当前选中分支"
   *
   * 消息树的每条边由父节点的 `activeChildId` 决定选中哪个孩子；
   * 而首条消息没有父节点，所以把「虚拟根」的指针放在会话上。
   * 这样全树只有**一套**机制决定激活路径，不存在双份真相。
   */
  activeRootChildId: MessageId | null;

  forkedFrom: ForkOrigin | null;

  /**
   * 手动排序位；`null` = 没被手动排过（此时按最近使用排）
   *
   * 不放进设置或单独的顺序表：顺序是"这一行的属性"，
   * 存到别处就会在导入/导出/备份时被漏掉，还会出现两份真相。
   */
  sortOrder: number | null;

  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;



  extensions?: Record<string, unknown>;
  schemaVersion: number;
}

export const CURRENT_CONVERSATION_SCHEMA_VERSION = 1;

/**
 * 新会话的默认标题
 *
 * 单独提成常量不是洁癖：`ChatService.send()` 靠**字符串相等**判断
 * "标题是否被用户改过"（没改过才按首条提问自动起名）。散落 6 处字面量，
 * 改名时漏掉任何一处，这个判断就会静默失效 —— 要么每次提问都覆盖用户的命名，
 * 要么永远停在"新对话"。
 */
export const DEFAULT_CONVERSATION_TITLE = '新对话';

/**
 * 标题长度上限
 *
 * 这个数字不是"数据规范"，而是**界面事实**：标题在侧栏和顶栏都只占一行，
 * 超长会把那一行撑破（顶栏尤其明显，它旁边还挤着工作区、模型、余额几个块）。
 * 放在领域层是因为它是"标题"这个概念的属性，而不是某个输入框的临时限制 ——
 * 两处输入（会话设置面板、侧栏重命名）共用同一个数。
 */
export const MAX_CONVERSATION_TITLE_LENGTH = 120;

export function createEmptyConversation(
  id: ConversationId,
  now: number,
  init?: Partial<Conversation>,
): Conversation {
  return {
    id,
    title: DEFAULT_CONVERSATION_TITLE,
    workspaceRoot: null,
    allowWorkspaceEdit: null,
    roleInstance: null,
    roleId: null,
    modelProfileId: null,
    model: null,
    params: {},
    systemPrompt: null,
    writingMode: 'chat',
    minOutputChars: null,
    continuationPrompt: null,
    keepRecentMessages: null,
    assistantName: null,
    userName: null,
    activeRootChildId: null,
    sortOrder: null,
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,

    schemaVersion: CURRENT_CONVERSATION_SCHEMA_VERSION,
    ...init,
  };
}

/**
 * 会话列表排序：越新越靠前
 *
 * 放在领域层是为了**只有一份顺序定义**：存储用 `updated_at DESC` 排序、
 * 应用层在内存里重排时必须与它一致，否则"刷新后顺序变了"这种 bug 极难查。
 */
export function compareConversationsByRecency(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt;
}

/** 从首条用户消息推导标题（模型生成标题属于 V1） */
export function deriveTitleFromText(text: string, maxLength = 24): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '新对话';
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}
