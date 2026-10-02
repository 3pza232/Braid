import type { MessageNode, MessageRole, MessageSegment } from '@domain/entities/message';
import { estimateTokens } from '@domain/value-objects/usage';
import type { TranscriptMessage } from './toolTranscript';
import type { MessageId } from '@shared/ids';

/**
 * 上下文压缩的**规划**（纯函数，不含任何模型调用）
 *
 * 这里只决定三件事：压哪一段、压多短、给压缩器看什么。
 * 真正的模型调用在 application 层的 `ContextCompressor` 里 ——
 * 这样"选哪段历史"这条最容易出错的规则可以脱离网络直接单测。
 */

export interface CompressionPlan {
  /** 要被摘要覆盖的节点（按激活路径顺序，最早的在前面） */
  nodes: MessageNode[];
  /** 覆盖的节点数 */
  coveredCount: number;
  /** 被覆盖部分的原始 token（用于告诉用户"压掉了多少"） */
  coveredTokens: number;
  /** 期望压缩到的 token 上限 */
  targetTokens: number;
}

/** 摘要要压到原长度的这个比例 —— 压得太狠会丢线索，太松又省不下多少 */
const TARGET_RATIO = 0.15;
/** 摘要的下限：再短就装不下"人物 + 设定 + 已做的事"这三样了 */
const TARGET_MIN_TOKENS = 300;
/** 摘要的上限：防止模型把摘要写得比原文还长 */
const TARGET_MAX_TOKENS = 4000;
/** 短于这个长度的历史不值得压（压缩本身的调用也有成本） */
const MIN_COVERED_TOKENS = 800;

/**
 * 把激活路径切成"轮"
 *
 * 与 contextPlan 用同一条规则：一条用户消息 + 它引发的回答与工具往来算一轮。
 * 切错的表现是"摘要里出现没有前文的半句话"，所以这条规则两处必须一致 ——
 * 这也是把它放在 domain 的原因。
 */
function groupTurns(path: readonly MessageNode[]): MessageNode[][] {
  const turns: MessageNode[][] = [];
  for (const node of path) {
    const last = turns[turns.length - 1];
    const startsNewTurn = node.role === 'user' || last === undefined || last[0].role === 'system';
    if (startsNewTurn) turns.push([node]);
    else last.push(node);
  }
  return turns;
}

export interface CompressionPlanInput {
  /** 激活路径（按顺序，最早的在前面） */
  path: readonly MessageNode[];
  /** 至少保留最近多少轮原文 */
  keepRecentTurns: number;
  /** 已经被上一轮摘要覆盖过的节点：不再重复喂给压缩器（它们的内容已在旧摘要里） */
  alreadySummarized: ReadonlySet<MessageId>;
}

/**
 * 挑选要压缩的历史；返回 null 表示"没什么可压的"
 *
 * 策略是**一次性把"最近 N 轮之前的所有历史"压成一段摘要**，
 * 而不是一次压一点。理由：
 *  - 摘要必须自成一体（人物、设定、进展要完整），零敲碎打会越压越碎；
 *  - 反复压缩时把旧摘要一起喂进去，信息逐次收敛而不是逐次丢失。
 */
export function planCompression(input: CompressionPlanInput): CompressionPlan | null {
  /*
   * 系统角色的节点不参与压缩
   *
   * 它们通常是人设与规则（"你是xxx，必须xxx"），一旦被改写，
   * 行为约束就松了 —— 这类内容必须逐字保留，宁可多占点空间。
   */
  const candidates = input.path.filter((node) => node.role !== 'system');
  const turns = groupTurns(candidates);

  const keep = Math.max(1, input.keepRecentTurns);
  const older = turns.slice(0, Math.max(0, turns.length - keep));
  const covered = older.flat().filter((node) => !input.alreadySummarized.has(node.id));

  if (covered.length === 0) return null;

  const coveredTokens = covered.reduce((sum, node) => sum + nodeTokens(node), 0);
  if (coveredTokens < MIN_COVERED_TOKENS) return null;

  const targetTokens = Math.min(
    TARGET_MAX_TOKENS,
    Math.max(TARGET_MIN_TOKENS, Math.round(coveredTokens * TARGET_RATIO)),
  );

  return { nodes: covered, coveredCount: covered.length, coveredTokens, targetTokens };
}

/**
 * 按「分段数组的引用」缓存 token 估算
 *
 * 顶栏的上下文用量会随每次流式 flush（约 120ms 一次）重算，而整条激活路径
 * 一起数是 O(总字数)。消息树的更新是**不可变**的：一次 flush 只会给
 * "正在流式的那一条"换一个新数组，其余节点的 `segments` 引用原封不动 ——
 * 所以以数组本身为键，未变化的节点必然命中，只有真正变化的那一条需要重算。
 *
 * 用 WeakMap 是为了让节点被丢弃后缓存自动回收，不需要任何显式失效逻辑；
 * 手动维护的缓存表正是"忘了清"这类内存泄漏的常见来源。
 */
const tokenCache = new WeakMap<readonly MessageSegment[], number>();

function nodeTokens(node: MessageNode): number {
  const cached = tokenCache.get(node.segments);
  if (cached !== undefined) return cached;

  let tokens = 0;
  for (const segment of node.segments) {
    if (segment.kind === 'text' || segment.kind === 'reasoning') tokens += estimateTokens(segment.text);
    else if (segment.kind === 'tool_call') tokens += estimateTokens(segment.call.argumentsJson);
    else if (segment.kind === 'tool_result') tokens += estimateTokens(segment.content);
  }
  tokenCache.set(node.segments, tokens);
  return tokens;
}

export interface ContextUsageInput {
  /** 激活路径（按顺序） */
  path: readonly MessageNode[];
  /** 已生效纪要占的 token */
  summaryTokens: number;
  /** 系统提示词（续写时它后面还会接工具说明） */
  systemPrompt: string;
  /** 这次即将追加的内容：用户的新消息或续写指令 */
  incoming?: string;
}

/**
 * 估算"下一次请求会占用多少上下文"
 *
 * 三条口径，每一条都对应过一个真实的显示错误：
 *  1. **只算激活路径** —— 别的分支不会被发出去（上一版数的是整棵树，
 *     于是出现"显示 154%、其实那些内容一次都没发出去"的怪象）；
 *  2. **已被纪要覆盖的节点不算** —— 它们真的不再发送了，只算纪要本身；
 *  3. **系统提示词要算上** —— 人设与工具说明动辄几千 token，漏掉它
 *     会让触发线形同虚设（以为还有一半空间，其实已经贴边）。
 */
export function estimateContextUsage(input: ContextUsageInput): number {
  let tokens = estimateTokens(input.systemPrompt) + estimateTokens(input.incoming ?? '') + input.summaryTokens;
  for (const node of input.path) {
    if (node.contextFlags?.summarized === true) continue;
    tokens += nodeTokens(node);
  }
  return tokens;
}

const ROLE_LABEL: Record<MessageRole, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
};

/**
 * 把若干节点还原成"给人看的一段对话"
 *
 * 刻意不复用发给模型的 transcript：那里面工具调用是 JSON、结果是原始文本，
 * 篇幅巨大且充满协议噪声；压缩器要读的是**内容**，不是协议。
 * 工具结果保留前 200 字即可 —— 摘要是要概括它，不是誊抄它。
 */
export function describeNodes(nodes: readonly MessageNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const parts: string[] = [];
    for (const segment of node.segments) {
      if (segment.kind === 'text' && segment.text.trim().length > 0) parts.push(segment.text.trim());
      else if (segment.kind === 'tool_result') {
        parts.push(`（工具 ${segment.name} 返回：${clip(segment.content, 200)}）`);
      }
    }
    if (parts.length === 0 && node.role === 'assistant') continue;
    lines.push(`${ROLE_LABEL[node.role]}：${parts.join('\n')}`);
  }
  return lines.join('\n\n');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 压缩器的系统提示词
 *
 * 写作要求围绕一件事：**只做记录，不做创作**。
 * 压缩最容易出的两个问题都来自"模型太想帮忙"：
 *  - 把摘要写成续写（凭空补上原文没有的情节）；
 *  - 把摘要写成读后感（"这段写得很精彩"），占字数还不带信息。
 * 所以逐条禁掉，并把"不确定就别写"明确说出来。
 */
export const COMPRESSION_SYSTEM_PROMPT = [
  '你是一个对话历史压缩器。你的唯一任务是把给定的对话压缩成一段可供后续对话使用的纪要。',
  '',
  '必须保留：',
  '1. 人物与设定：出现过的角色、称谓、外貌性格、世界观规则、已确立的事实；',
  '2. 用户的偏好与要求：明确说过的喜好、禁止项、格式要求；',
  '3. 已完成的动作与结果：做过什么、结果是什么、写过哪些文件；',
  '4. 未解决的线索：悬而未决的问题、待办、用户等待的答复。',
  '',
  '必须丢弃：寒暄、重复表述、助手对自己的说明与元话语（如"好的，我来帮你"）、',
  '以及任何一次性的过程细节（除非它是结论的一部分）。',
  '',
  '硬性要求：',
  '- 只做客观记录，**不要续写**、不要补充原文没有的内容、不要评价；',
  '- 不确定的信息宁可省略，也不要猜测；',
  '- 用与原文相同的语言，保持时态与人称一致；',
  '- 直接输出纪要正文，不要任何前言、标题或"以下是摘要"之类的话。',
].join('\n');

/** 组装发给压缩器的消息 */
export function buildCompressionMessages(input: {
  transcript: string;
  previousSummary: string | null;
  targetTokens: number;
}): TranscriptMessage[] {
  const parts: string[] = [];
  if (input.previousSummary) {
    /*
     * 旧摘要必须一起喂进去
     *
     * 不然这次压缩会把它覆盖掉，而它装着更早的历史 ——
     * 表现为"压第二次之后，前十轮的事全没了"。
     */
    parts.push('【此前的纪要（更早的对话已经压缩过）】', input.previousSummary, '');
  }
  parts.push('【需要压缩的对话】', input.transcript);
  parts.push(
    '',
    `请把以上内容压成一段不超过约 ${input.targetTokens} token 的纪要。`,
  );

  return [
    { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') },
  ];
}

/** 摘要以什么身份回到对话里（放在系统提示词之后、其余历史之前） */
export function summaryMessage(text: string): TranscriptMessage {
  return {
    role: 'system',
    content: [
      '【历史对话纪要】以下是本次对话较早部分的压缩纪要，细节已省略但主线与设定完整保留。',
      '请把它当作已经发生过的对话事实继续，不要询问纪要里提到过的事情，也不要重复它。',
      /*
       * 必须点明"这不是文风范例"
       *
       * 纪要本身是**条目式**的（人物/设定/已完成/待办，见 COMPRESSION_SYSTEM_PROMPT），
       * 而它被放在历史**最前面**。不加这句时，模型很容易顺着这个形状往下写 ——
       * 表现是续写变成"一行一章"的提纲（真实反馈过），而它其实什么都没做错：
       * 上文给它的形状就是提纲。一句说明比调参数有效得多。
       */
      '注意：它只是一份记录，**不是文风或结构范例** —— 继续写正文时请沿用原文的叙事密度与写法，不要写成条目、提纲或"一章一行"的提要。',
      '',
      text,
    ].join('\n'),
  };
}

