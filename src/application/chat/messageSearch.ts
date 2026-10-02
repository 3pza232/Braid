import type { MessageNode } from '@domain/entities/message';
import type { MessageId } from '@shared/ids';
import type { MessageSearchHit } from '@ports/repositories/MessageStore';

/**
 * 正文搜索
 *
 * 【搜索范围 = 当前会话里**看得见的**内容】
 * 只扫传进来的这条激活路径，而不是整个数据库。三个后果都是我们要的：
 *
 *  1. **结果一定看得见**。编辑与"重新生成"都会留下旧分支（库里有、屏幕上没有），
 *     按数据库搜就会搜出一堆"跳过去什么都没发生"的命中 —— 那不是搜索，
 *     那是把用户引到一堵墙上；
 *  2. **顺序天然是从上到下**（按会话里的先后），符合"找一段话"的直觉，
 *     而不是按创建时间倒序把最后一句排在第一条；
 *  3. 不必过一遍 SQLite 再解析回节点 —— 当前会话的树本来就在内存里。
 *
 * 范围**不含**其它会话：要跨会话找"我哪天说过那句话"是另一个功能
 * （它需要的是会话级摘要/时间线），塞进同一个搜索框只会让两边都做不好。
 */

/** 命中位置的上下文截取长度（字符） */
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 40;

/**
 * 命中数上限
 *
 * 搜索是给人"找回一段话"用的，不是导出工具。一个常见词在长会话里能有上千处，
 * 全部返回既没人看，也会让"下一处"变成折磨。
 */
const MAX_HITS = 200;

/**
 * 粗筛阶段最多取回多少条候选
 *
 * 300 条候选足以覆盖"这句话在哪个会话里说过"，同时把内存占用钉死 ——
 * 一个常见词在多年记录里能有上万处，全读回来只为了让用户看前几处，不值。
 */
export const CANDIDATE_LIMIT = 300;

/**
 * 在一条激活路径里搜索
 *
 * 一处命中一条记录（**不是一条消息一条**）：
 * 同一个词在一条消息里出现 8 次，用户要的是逐处跳转。
 */
export function searchActivePath(
  path: readonly MessageNode[],
  query: string,
): MessageSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: MessageSearchHit[] = [];

  for (const node of path) {
    if (node.deletedAt !== null) continue;

    /*
     * 正文（用户的话 + 模型正文）优先，思考过程兜底
     *
     * 正文里能看到命中的时候就不必把思考过程也算进来 —— 否则用户会被
     * "跳过去还得先展开思考"绊住，而那个词在正文里明明看得见。
     *
     * **工具结果不参与**。它是机器输出（目录清单、文件正文、接口返回……）：
     * 体量最大、噪声最多，而且搜的时候用户想找的是"谁说过什么"，
     * 不是"哪个文件里出现过这个词"。命中了也没法跳 —— 那段文字渲染在
     * 悬浮面板里且有长度上限，用户看不到，纯属把人引到一堵墙上。
     * 真要按文件内容找，工作区文件本身就在那儿，那是另一件事。
     */
    const body: string[] = [];
    const reasoning: string[] = [];
    for (const segment of node.segments) {
      if (segment.kind === 'text') body.push(segment.text);
      else if (segment.kind === 'reasoning') reasoning.push(segment.text);
    }

    const bodyFound = findOccurrences(body, needle);
    const reasoningFound = findOccurrences(reasoning, needle);
    const emitted = bodyFound.length > 0 ? bodyFound : reasoningFound;
    if (emitted.length === 0) continue;

    for (const found of emitted) {
      hits.push({
        conversationId: node.conversationId,
        messageId: node.id,
        snippet: snippetOf(found.text, needle.length, found.index),
        reasoningOnly: bodyFound.length === 0,
        occurrence: found.occurrence,
      });
      if (hits.length >= MAX_HITS) return hits;
    }
  }

  return hits;
}

export interface CrossSearchInput {
  /** 粗筛出来的候选：可能含旧分支上的、以及只在（已排除的）工具结果里出现的 */
  candidates: readonly MessageNode[];
  /**
   * 每个会话**当前可见的**路径（节点 id，按屏幕顺序）
   *
   * Map 的插入顺序就是结果的先后 —— 调用方按"最近使用"填进来，
   * 于是"下一处"走下来是：从最近的对话开始，每条会话从上往下。
   */
  pathByConversation: ReadonlyMap<string, readonly MessageId[]>;
}

/**
 * 跨会话搜索：在**每个会话当前可见的那条路径**上逐处定位
 *
 * 这是"粗筛 → 轻查 → 精判"的最后一步，也是唯一能保证
 * "每一条结果都真的看得见"的地方：
 * 旧分支（编辑、重新生成留下的）仍在库里，粗筛会把它们捞出来，
 * 而它们的正文永远不会出现在屏幕上 —— 不在这里滤掉，
 * 用户按"下一处"就会跳到一片空白上。
 */
export function searchVisibleAcrossConversations(
  input: CrossSearchInput,
  query: string,
): MessageSearchHit[] {
  const byConversation = new Map<string, Map<MessageId, MessageNode>>();
  for (const candidate of input.candidates) {
    const bucket = byConversation.get(candidate.conversationId) ?? new Map<MessageId, MessageNode>();
    bucket.set(candidate.id, candidate);
    byConversation.set(candidate.conversationId, bucket);
  }

  const hits: MessageSearchHit[] = [];

  for (const [conversationId, pathIds] of input.pathByConversation) {
    const bucket = byConversation.get(conversationId);
    if (!bucket) continue;

    /*
     * 按**路径顺序**重排候选，而不是按粗筛返回的顺序
     *
     * 粗筛按 `created_at DESC` 出结果，直接用它的话，"下一处"会在同一条会话里
     * 从下往上跳 —— 与用户读的方向相反。路径本身就是屏幕顺序，用它排最自然。
     */
    const ordered = pathIds
      .map((id) => bucket.get(id))
      .filter((node): node is MessageNode => node !== undefined);
    if (ordered.length === 0) continue;

    hits.push(...searchActivePath(ordered, query));
    if (hits.length >= MAX_HITS) break;
  }

  return hits.slice(0, MAX_HITS);
}

interface Found {
  text: string;
  /** 词在这段文字里的起始下标 */
  index: number;
  /** 这是这一组文字里的第几处（0 起，按先后顺序） */
  occurrence: number;
}

/**
 * 找出这几段文字里的**全部**命中
 *
 * 编号按传入顺序累加，也就是屏幕上从上到下的顺序。
 * 只对**会被渲染出来的那一组**编号：没被渲染的那一份参与编号就会错位到别的词上。
 */
function findOccurrences(texts: readonly string[], needle: string): Found[] {
  const found: Found[] = [];
  let occurrence = 0;

  for (const text of texts) {
    const lower = text.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      found.push({ text, index, occurrence });
      occurrence += 1;
      index = lower.indexOf(needle, index + needle.length);
    }
  }
  return found;
}

/**
 * 取命中处的上下文片段
 *
 * 位置由调用方给出（它已经扫过一遍），这里不再自己找"第一处" ——
 * 那样做的话，同一个词在一段里出现多次时，每处的片段都截在**第一处**上，
 * 看起来像"重复的命中"。
 */
function snippetOf(text: string, length: number, index: number): string {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SNIPPET_AFTER);
  const body = text.slice(start, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
