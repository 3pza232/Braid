import { asToolCallId, type ConversationId, type MessageId, type ToolCallId } from '@shared/ids';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';

/**
 * 角色 / 状态 / 结束原因
 *
 * 【为什么是"运行时数组 + 派生类型"，而不是直接写联合类型】
 * 存储层要**按运行时清单**校验从库里读出来的值（坏数据不许冒到界面），
 * 而"有哪些取值"这件事只能有一份：写成联合类型、另写一个数组的话，
 * 加一个取值就会漏改一处 —— 漏在存储层，新值会被当成坏数据悄悄丢掉。
 * 所以清单在这里定义一次，类型从它派生。
 */
export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_STATUSES = ['draft', 'streaming', 'complete', 'error', 'aborted'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'aborted',
  'error',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/** 模型发起的一次工具调用 */
export interface ToolCall {
  id: ToolCallId;
  name: string;
  /** 原始 JSON 字符串：流式拼接期间可能不完整，必须保留原样 */
  argumentsJson: string;
  /** 解析成功后的对象（解析失败时为 undefined，UI 需给出降级展示） */
  parsed?: unknown;
}

/**
 * 消息内容分段
 *
 * 用"分段数组"而不是单一字符串，是为了让 reasoning（思考过程）、
 * tool_call / tool_result、未来的 image 都能被独立渲染与折叠，
 * 同时避免给 MessageNode 增加大量可选字段。
 */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; redacted?: boolean }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_result'; callId: ToolCallId; name: string; content: string; isError: boolean }
  | { kind: 'summary'; summaryId: string; coversMessageIds: MessageId[]; tokens: number }
  | { kind: 'image'; ref: string; mimeType: string; alt?: string };

/**
 * 上下文相关的标记
 *
 * 只保留**真的有人在读**的字段：`summarized` / `summaryId` 由压缩与消息组装读。
 * （曾经还有 `pinned` / `excluded`，从没有消费方 —— 只写不读的字段会让人
 * 基于"这功能存在"去改代码，已于本轮删除。）
 */
export interface ContextFlags {
  /** 已被摘要覆盖（原文不再发送） */
  summarized?: boolean;
  summaryId?: string;
}

/**
 * 消息节点 —— 消息树的节点
 *
 * 关键设计（「编辑即分支」，见 docs/02-domain.md）：
 *  - parentId 决定树结构，同一 parent 下的多个子节点互为「变体」；
 *  - activeChildId 决定「当前激活路径」——即用户实际看到的那条线；
 *  - variantOf 把同一逻辑消息的多个变体归组，UI 用它在气泡上显示 ‹ 2/3 ›。
 *
 * 因此"编辑一条历史消息"= 新建一个同组变体节点 + 切换 activeChildId，
 * 原节点从不被覆盖，天然可回溯、可对比。
 */
export interface MessageNode {
  id: MessageId;
  /**
   * 所属会话
   *
   * 与其余 id 一样是**品牌类型**：它一度是裸 `string`，于是"把消息 id 传成会话 id"
   * 这类错误编译器看不见，只能在界面上表现为"跳过去是空的"。
   * 数据库行是外部边界，在那里显式转换（`asConversationId`）。
   */
  conversationId: ConversationId;
  parentId: MessageId | null;

  /** 同一逻辑消息的所有变体共享此值；自身为组长时 variantOf === id */
  variantOf: MessageId;
  variantIndex: number;

  /** 决定激活路径：当前选中哪个孩子。null = 尚未选择 */
  activeChildId: MessageId | null;

  role: MessageRole;
  segments: MessageSegment[];
  status: MessageStatus;

  /** 复现所需快照：改参数后旧消息仍能解释自己是怎么生成的 */
  modelRef?: string;
  paramsSnapshot?: SamplingParams;
  roleIdAtCreation?: string;
  usage?: TokenUsage;
  finishReason?: FinishReason;

  contextFlags?: ContextFlags;

  /*
   * 有过两个"续写过程记录"字段（`continuationIndex` / `reachedTarget`），已删除
   *
   * 它们写了从来没人读：界面不显示、引擎的下一次决策也不看它们。
   * 而它们记录的**信息本身没有丢**：续了几轮 = 这条消息里有几段正文
   *（每续一轮固化一段），有没有写到下限 = 正文长度与档位下限的对比。
   * 留着不读的字段会让人以为它们参与判断，从而基于错误前提去改代码；
   * 真要诊断"这条为什么只有 300 字"，看段落数与设置就够了。
   * 列是用迁移 v9 删的（旧库里那点数据是纯派生值，没有丢失一说）。
   */

  createdAt: number;
  updatedAt: number;
  /** 软删除时间戳；回收站依赖它 */
  deletedAt: number | null;

  /** 未知字段透传：保证未来版本新增字段在旧版本往返时不被丢弃 */
  extensions?: Record<string, unknown>;
  schemaVersion: number;
}

export const CURRENT_MESSAGE_SCHEMA_VERSION = 1;

/** 拼接所有文本段（导出、复制、字数统计用） */
export function messageText(node: MessageNode): string {
  return node.segments
    .filter((s): s is Extract<MessageSegment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.text)
    .join('');
}

/**
 * 用流式已累积的内容重建分段
 *
 * reasoning 段固定排在正文之前（先思考再作答）。正文段**始终存在**，
 * 哪怕还是空串 —— 这样界面不必区分"还没有正文"和"没有正文段"两种情况。
 */
export function withStreamedContent(
  node: MessageNode,
  text: string,
  reasoning: string,
  now: number,
  toolSegments: readonly MessageSegment[] = [],
): MessageNode {
  /*
   * `toolSegments` 是**已经结束的轮次**留下的段（正文 + 工具调用 + 工具结果），
   * 必须原样排在前面：工具调用一旦发生就是既成事实，
   * 不能因为"正在流式更新正文"就把它们覆盖掉 —— 那样模型在下一轮里
   * 会看不到自己刚才调过什么，于是重复调用同一个工具。
   */
  const segments: MessageSegment[] = [...toolSegments];
  if (reasoning.length > 0) segments.push({ kind: 'reasoning', text: reasoning });
  segments.push({ kind: 'text', text });
  return { ...node, segments, status: 'streaming', updatedAt: now };
}

/**
 * 造一个工具调用
 *
 * `parsed` 在这里解析一次并缓存：调用方（工具执行器、界面）都要用它，
 * 而流式拼接出来的 JSON 有可能不完整 —— 解析失败时**保留原始字符串**、
 * 把 `parsed` 留空，让调用方走降级路径，而不是丢掉这个调用。
 */
export function createToolCall(id: string, name: string, argumentsJson: string): ToolCall {
  const call: ToolCall = { id: asToolCallId(id), name, argumentsJson };
  if (argumentsJson.trim().length === 0) return call;
  try {
    return { ...call, parsed: JSON.parse(argumentsJson) as unknown };
  } catch {
    return call;
  }
}


