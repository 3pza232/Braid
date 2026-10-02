import { nanoid } from 'nanoid';
import type { MessageNode, MessageRole, MessageStatus } from '@domain/entities/message';
import { CURRENT_MESSAGE_SCHEMA_VERSION } from '@domain/entities/message';
import type { TreeState } from '@domain/rules/messageTreeEdits';
import { summaryMessage } from '@domain/rules/contextCompression';
import { appendSegmentsToTranscript } from '@domain/rules/toolTranscript';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';
import { estimateCacheStats, estimateTokens } from '@domain/value-objects/usage';
import type { ConversationId } from '@shared/ids';
import type { ProviderMessage } from '@ports/LLMProvider';
import { asMessageId, type MessageId } from '@shared/ids';
import type { AppError } from '@shared/result';

/**
 * 消息装配：把「领域里的消息树」变成「发给模型的消息序列」
 *
 * 从 ChatService 里独立出来，因为它是**整条链路里最敏感的一段**，
 * 而且与"流式怎么跑、工具怎么执行、什么时候落库"这些流程无关 ——
 * 全是纯函数，可以直接单测（tests/application/messageAssembly.test.ts）。
 *
 * 为什么敏感：它决定了提示词的**逐字节形态**，而前缀缓存要求
 * "与上一次请求从头开始完全一致"。任何顺序抖动、任何多加一个字段，
 * 都会让后面几万 token 的缓存全部失效 —— 用户看不见，只会觉得"变贵了"。
 */

/**
 * 失败标记
 *
 * Schema 里没有"错误"字段，所以失败原因只能写进正文 —— 这是唯一能保住
 * "这条回复为什么长这样"的位置。用醒目的符号开头，让用户一眼分辨
 * 那是系统信息而不是模型说的话。
 */
export const FAILURE_MARK = '⚠️';

interface NodeInit {
  conversationId: ConversationId;
  parentId: MessageId | null;
  role: MessageRole;
  text: string;
  variantIndex: number;
  now: number;
  variantOf?: MessageId;
  modelRef?: string | null;
  status?: MessageStatus;
  paramsSnapshot?: SamplingParams;
  roleIdAtCreation?: string | null;
}

export function createNode(init: NodeInit): MessageNode {
  const id = asMessageId(`msg-${nanoid(12)}`);
  const modelRef = init.modelRef ?? null;

  return {
    id,
    conversationId: init.conversationId,
    parentId: init.parentId,
    variantOf: init.variantOf ?? id,
    variantIndex: init.variantIndex,
    activeChildId: null,
    role: init.role,
    segments: [{ kind: 'text', text: init.text }],
    status: init.status ?? 'complete',
    ...(modelRef ? { modelRef } : {}),
    ...(init.roleIdAtCreation ? { roleIdAtCreation: init.roleIdAtCreation } : {}),
    ...(init.paramsSnapshot ? { paramsSnapshot: init.paramsSnapshot } : {}),
    finishReason: 'stop',
    contextFlags: {},
    createdAt: init.now,
    updatedAt: init.now,
    deletedAt: null,
    schemaVersion: CURRENT_MESSAGE_SCHEMA_VERSION,
  };
}

/**
 * 构造请求消息列表
 *
 * 从虚拟根沿激活路径走，在**待生成的那条回复之前**停下 ——
 * 那条回复是空的占位，发出去会让模型以为要接着写自己的话。
 *
 * 顺序严格照树的顺序，不做任何重排或去重：前缀缓存要的就是"和前一次逐字节一致"。
 */
export function buildProviderMessages(
  systemPrompt: string,
  tree: TreeState,
  stopBefore: MessageId,
  /**
   * 上下文压缩的纪要（`null` = 没有压过）
   *
   * 它必须放在**系统提示词之后、其余历史之前**：位置靠前，模型才会把
   * 它当作"已经发生过的对话"来读；放到末尾就成了"刚刚有人给我一段总结"，
   * 模型会把它当成新指令。
   */
  summary: string | null = null,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  if (systemPrompt.trim().length > 0) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (summary && summary.trim().length > 0) {
    messages.push(summaryMessage(summary));
  }

  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const guard = new Set<MessageId>();
  let cursor = tree.activeRootChildId;

  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = byId.get(cursor);
    if (!node || node.deletedAt !== null) break;
    if (node.id === stopBefore) break;
    /*
     * 已被压缩覆盖的节点不再逐条发送 —— 它们的内容已在纪要里。
     * 注意是"不再发送"，不是"删除"：原文仍在树里、仍能搜索与复制，
     * 只是不再占上下文。这一点直接决定了压缩是否可逆。
     */
    if (node.contextFlags?.summarized === true) {
      cursor = node.activeChildId;
      continue;
    }

    /*
     * 交给规则层重组，而不是"只取正文"
     *
     * 以前这里是把段的正文拼起来发出去，工具往来会被整个丢掉 ——
     * 结果是模型在第二轮里看不到自己刚调过什么，于是把同一个工具再调一遍。
     * 现在由 `appendSegmentsToTranscript` 按协议要求把工具往来还原成
     * `assistant(tool_calls)` + `tool(...)` 的序列（顺序错了请求会被直接拒）。
     */
    appendSegmentsToTranscript(messages, node.role, node.segments);
    cursor = node.activeChildId;
  }

  return messages;
}

/**
 * 把请求内容序列化成**稳定**字符串（只用于缓存命中估算）
 *
 * 用不可见分隔符而不是换行：正文里本来就有换行，用换行当分隔会让
 * "两条短消息"与"一条长消息"产生同样的串，前缀长度就算错了。
 * 除 role 与 content 之外**不带任何东西** —— 带索引或时间戳都会让相邻两次请求失去公共前缀。
 */
export function serializePrompt(messages: ProviderMessage[]): string {
  return messages.map((message) => `${message.role}\u0000${message.content}`).join('\u0001');
}

/** 失败原因追加进正文（Schema 没有错误字段，这是唯一能保住原因的位置） */
export function appendFailure(text: string, error: AppError): string {
  const marker = `${FAILURE_MARK} ${error.message}`;
  return text.trim().length > 0 ? `${text.trimEnd()}\n\n${marker}` : marker;
}

/**
 * 产出最终的用量
 *
 * 三档可信度，从高到低：
 *  1. 服务端给了缓存字段 → 原样使用（精确）；
 *  2. 服务端给了用量但没给缓存字段 → 用量保留，只把缓存部分标为估算；
 *  3. 什么都没有（被中止、或端点没实现 include_usage）→ 全部转为估算并标注。
 * 编辑器/界面据此显示"缓存 78%"还是"缓存≈78%"。
 */
export function resolveUsage(
  usage: TokenUsage | undefined,
  previousPrompt: string,
  promptText: string,
  text: string,
): TokenUsage | undefined {
  const estimate = estimateCacheStats(previousPrompt, promptText);

  if (usage) {
    if (usage.cachedPromptTokens !== undefined) return usage;
    return {
      ...usage,
      cachedPromptTokens: Math.min(estimate.hitTokens, usage.promptTokens),
      cacheSource: 'estimated',
    };
  }

  const completionTokens = estimateTokens(text);
  const promptTokens = estimate.hitTokens + estimate.missTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: estimate.hitTokens,
    cacheSource: 'estimated',
  };
}

/**
 * 按**对象身份**找出被改动过的节点
 *
 * 领域函数是不可变的：未改动的节点原样返回同一个引用，只有改动过的才新建对象。
 * 所以这里不需要任何脏标记或深比较 —— 一次引用比较就够，
 * 且天然正确（漏改=没变，不会误写）。
 */
export function changedNodes(before: MessageNode[], after: MessageNode[]): MessageNode[] {
  const beforeById = new Map<MessageId, MessageNode>();
  for (const node of before) beforeById.set(node.id, node);
  return after.filter((node) => beforeById.get(node.id) !== node);
}
