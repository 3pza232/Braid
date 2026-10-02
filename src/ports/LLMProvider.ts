import type { FinishReason, ToolCall } from '@domain/entities/message';
import type { TranscriptMessage } from '@domain/rules/toolTranscript';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';
import type { AppError, Result } from '@shared/result';


/**
 * 送给模型的单条消息
 *
 * 刻意用**极简结构**（role + content 字符串）而不是直接暴露内部 `MessageNode`：
 *  - 请求构造与内部数据结构解耦，以后消息加字段不会意外泄漏到请求体里；
 *  - 也让"序列化必须稳定"这件事可控 —— 前缀缓存要求逐字节一致（见 usage.ts）。
 */
/**
 * 一条请求消息
 *
 * 结构定义在 domain（`rules/toolTranscript.ts`）—— 因为"怎么把消息段重建成
 * 合法消息序列"是一条纯规则，需要能被 Node 直接测。这里只做别名，
 * 保证适配器看到的类型就是领域定义的那一个（不会漂移成两份）。
 */
export type ProviderMessage = TranscriptMessage;

/**
 * 工具声明（OpenAI 兼容格式）
 *
 * 刻意保持成"就是那段 JSON"而不是再抽象一层：各家的工具协议差异很大，
 * 硬抽象会把未来的非兼容协议卡死。适配器负责把它放进请求体。
 */
export interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema 形式的参数说明 */
    parameters: Record<string, unknown>;
  };
}

/**
 * 连接信息
 *
 * 由**调用方（ChatService）从解析后的模型配置里取**，随请求一起传进来，
 * 而不是让适配器自己去读设置 —— 这样适配器是无状态的：
 * 同一个实例能同时服务多个配置，测试连接也能复用它。
 */
export interface ProviderConnection {
  baseUrl: string;
  /** 手填的 Key。**没有从环境变量读的路**（见 openAICompatProvider 的 resolveApiKey） */
  apiKey: string;
  requestTimeoutMs: number;
  /** 用户手写的额外请求体字段（JSON 文本） */
  extraBodyJson: string;
}

export interface ChatRequest extends ProviderConnection {
  model: string;
  messages: ProviderMessage[];
  params: SamplingParams;
  /** 可用工具。为空/未传时**完全不发送 tools 字段**，让普通对话保持原样 */
  tools?: ProviderTool[];
  /** 用户点「停止」时触发 */
  signal?: AbortSignal;
}

/** 连通性测试结果 */
export interface ProbeResult {
  latencyMs: number;
  /** 服务端返回的正文（通常是模型的答复），空串表示通了但没给内容 */
  reply: string;
}

/**
 * 一次性补全请求（非流式）
 *
 * 存在的理由只有一个：上下文压缩需要**一整段完整文本**当结果 ——
 * 复用流式接口再自己拼接，等于把 SSE 的碎片处理又实现一遍，
 * 而且压缩的中间态（写到一半的纪要）没有任何用处。
 */
export interface CompleteRequest {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  extraBodyJson: string;
  model: string;
  messages: ProviderMessage[];
  params?: SamplingParams;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage?: TokenUsage;
}

/**
 * 流式事件
 *
 * 用**判别联合**而不是回调：这样调用方可以用 `for await` 顺序处理，
 * 天然支持背压与提前 break（用户中止时直接跳出循环即可）。
 */
export type ChatStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  /**
   * 模型要求调用一个工具
   *
   * 约定：**只在流结束时一次性给出完整调用**，不吐"拼到一半"的中间态 ——
   * 参数是碎片拼起来的，中途给出的是不合法 JSON，消费方拿到只能存半截。
   * 同一个响应里可以有多个（并行调用）。
   */
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'done'; finishReason: FinishReason }
  | { kind: 'error'; error: AppError };



/**
 * 模型提供方端口
 *
 * 只要求"能流式聊一次"，不要求任何厂商特有概念。
 * 新增一家提供商 = 新增一个实现 + 组合根加一行（A1 单点新增）。
 */
export interface LLMProvider {
  readonly id: string;
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;

  /**
   * 连通性测试
   *
   * 发一个**最小请求**（只让它回一两个字）验证三件事同时成立：
   * 地址可达、凭据有效、模型名存在。
   * 只查 `/models` 是不够的 —— 那验证不了模型名，也验证不了对话权限。
   *
   * 放在端口上而不是另建一个服务：只有适配器知道"这家怎么写请求"。
   */
  probe(connection: ProviderConnection, model: string): Promise<Result<ProbeResult>>;

  /**
   * 一次性补全（非流式）
   *
   * 目前唯一的用途是**上下文压缩**：把最早的历史交给模型改写成一段纪要。
   * 与 `streamChat` 分开而不是加个开关：调用方的用法完全不同 ——
   * 这里要的是"等它说完，然后拿整段文本"，中间的过程没有任何意义。
   */
  complete(request: CompleteRequest): Promise<Result<CompleteResult>>;
}

/*
 * 端口文件只放契约，不放实现 —— 凭据解析（要读构建期环境）属于宿主访问，
 * 放在 adapters/providers 里。
 */
