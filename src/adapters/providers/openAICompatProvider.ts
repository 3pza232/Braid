import { createToolCall, type FinishReason, type ToolCall } from '@domain/entities/message';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { TokenUsage } from '@domain/value-objects/usage';
import type {
  ChatRequest,
  ChatStreamEvent,
  CompleteRequest,
  CompleteResult,
  LLMProvider,
  ProbeResult,
  ProviderConnection,
  ProviderMessage,
} from '@ports/LLMProvider';
import { appError, err, ok, type AppError, type ErrorCode, type Result } from '@shared/result';

/**
 * OpenAI 兼容的流式聊天适配器
 *
 * 覆盖 DeepSeek / OpenAI / Ollama / vLLM / 各种自建网关 —— 它们都实现了
 * `POST {baseUrl}/chat/completions` 的 SSE 协议。
 *
 * 【为什么不包官方 SDK】
 *  - 体积：一个 SDK 动辄几百 KB，而我们只需要"发一个 POST + 读 SSE"；
 *  - 可控：真实错误（限流、余额、上下文超限）都在 HTTP 状态与响应体里，
 *    自己解析能给出准确的中文提示，而不用把 SDK 的异常字符串抛给用户；
 *  - 兼容：DeepSeek 的 `reasoning_content`、缓存字段都能按需处理，
 *    不必等 SDK 升级。
 *
 * 【错误约定】所有失败都以 `{ kind: 'error' }` 事件产出，**不抛异常**：
 * 抛出去会中断 `for await`，调用方只能靠 try/catch 兜底、拿不到结构化错误码。
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 适配器是**无状态**的
 *
 * 连接信息随请求传进来（由 ChatService 从解析后的模型配置里取），
 * 所以一个实例能同时服务多份配置，「测试连接」也能复用它 ——
 * 不必为"试试这个新配置"再 new 一个 provider。
 */
export function createOpenAICompatProvider(): LLMProvider {
  return {
    id: 'openai-compat',

    async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
      const guard = validate(request);
      if (guard) {
        yield { kind: 'error', error: guard };
        return;
      }

      const extraBody = parseExtraBody(request.extraBodyJson);
      if (extraBody === null) {
        yield {
          kind: 'error',
          error: appError(
            'VALIDATION_ERROR',
            '「额外请求体」不是合法的 JSON，请到设置里检查',
            { retryable: false },
          ),
        };
        return;
      }

      const timeoutMs = request.requestTimeoutMs > 0 ? request.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
      const { signal, cancel } = combineSignals(request.signal, timeoutMs);

      try {
        const response = await fetch(endpointOf(request.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolveApiKey(request)}`,
          },
          // 额外字段作为基底，Braid 自己接管的字段后写覆盖 ——
          // 允许用户补参数，但不允许改坏 model/messages/stream（那会让流式解析崩掉）
          body: JSON.stringify({
            ...extraBody,
            model: request.model,
            messages: request.messages.map(toWireMessage),
            stream: true,
            // DeepSeek 与 OpenAI 都支持：让最后一帧带上 token 用量与缓存命中数。
            // 没有它就只能全程靠估算，命中率也就只能是"约"。
            stream_options: { include_usage: true },
            // 没有工具时**完全不发这个字段**：个别网关会把空数组判成非法参数
            ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
            ...toBodyParams(request.params),
          }),
          signal,
        });

        if (!response.ok) {
          yield { kind: 'error', error: await httpError(response) };
          return;
        }
        if (!response.body) {
          yield {
            kind: 'error',
            error: appError('UPSTREAM_SERVER_ERROR', '服务端没有返回流式内容'),
          };
          return;
        }

        yield* parseSse(response.body, signal);
      } catch (error) {
        yield { kind: 'error', error: transportError(error, request.signal?.aborted === true) };
      } finally {
        cancel();
      }
    },

    /**
     * 连通性测试
     *
     * 用一个**最小请求**（要 1 个 token）同时验证地址、凭据、模型名。
     * 不用非流式接口：多一条代码路径就多一处可能出错的地方，
     * 而且真实使用时走的就是流式，用同一条路径测才测得准。
     */
    /*
     * 一次性补全（非流式）
     *
     * 与 streamChat 走同一个端点、同一套错误映射 —— 差别只在 `stream: false`。
     * 刻意不带 tools：压缩是一次纯文本改写，给它工具只会让它"顺手查点东西"。
     */
    async complete(request: CompleteRequest): Promise<Result<CompleteResult>> {
      const guard = validate(request);
      if (guard) return err(guard);

      const extraBody = parseExtraBody(request.extraBodyJson);
      if (extraBody === null) {
        return err(appError('VALIDATION_ERROR', '额外请求字段不是合法的 JSON'));
      }

      const timeoutMs = request.requestTimeoutMs > 0 ? request.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
      const { signal, cancel } = combineSignals(request.signal, timeoutMs);

      try {
        const response = await fetch(endpointOf(request.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolveApiKey(request)}`,
          },
          body: JSON.stringify({
            ...extraBody,
            model: request.model,
            messages: request.messages.map(toWireMessage),
            stream: false,
            ...toBodyParams(request.params ?? {}),
          }),
          signal,
        });

        if (!response.ok) return err(await httpError(response));

        const payload = (await response.json()) as RawCompletion;
        const text = payload.choices?.[0]?.message?.content;

        /*
         * 空内容当失败处理，而不是返回一个空串
         *
         * 压缩返回空串意味着"这段历史被压没了" —— 上层如果把它当成成功，
         * 就会用一段空纪要替换掉真实的历史，那是不可逆的信息丢失。
         * 让它失败，上层才会走"这次不压"的降级路径。
         */
        if (typeof text !== 'string' || text.trim().length === 0) {
          return err(
            appError('UPSTREAM_BAD_REQUEST', '压缩请求返回了空内容（模型可能拒绝了这次改写）'),
          );
        }

        return ok({
          text: text.trim(),
          ...(payload.usage ? { usage: toUsage(payload.usage) } : {}),
        });
      } catch (error) {
        if (signal.aborted) return err(appError('ABORTED', '已停止'));
        return err(appError('NETWORK_ERROR', error instanceof Error ? error.message : '请求失败'));
      } finally {
        cancel();
      }
    },

    async probe(connection: ProviderConnection, model: string): Promise<Result<ProbeResult>> {
      const target = { ...connection, model };
      const guard = validate(target);
      if (guard) return err(guard);

      const extraBody = parseExtraBody(connection.extraBodyJson);
      if (extraBody === null) {
        return err(appError('VALIDATION_ERROR', '「额外请求体」不是合法的 JSON'));
      }

      const timeoutMs = connection.requestTimeoutMs > 0 ? connection.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
      const { signal, cancel } = combineSignals(undefined, Math.min(timeoutMs, 30_000));
      const startedAt = Date.now();

      try {
        const response = await fetch(endpointOf(connection.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolveApiKey(connection)}`,
          },
          body: JSON.stringify({
            ...extraBody,
            model,
            messages: [{ role: 'user', content: 'hi' }],
            // 只要 1 个 token：验证连通性不需要内容，不必为此付一次完整的钱
            max_tokens: 1,
            stream: false,
          }),
          signal,
        });

        if (!response.ok) return err(await httpError(response));

        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload.choices?.[0]?.message?.content;

        return ok({
          latencyMs: Date.now() - startedAt,
          reply: typeof content === 'string' ? content : '',
        });
      } catch (error) {
        return err(transportError(error, false));
      } finally {
        cancel();
      }
    },
  };
}

/* ────────────────────────── 请求构造 ────────────────────────── */

function validate(target: ProviderConnection & { model: string }): AppError | null {
  if (!target.baseUrl.trim()) return appError('VALIDATION_ERROR', '还没有填写接口地址');
  if (!target.model.trim()) return appError('VALIDATION_ERROR', '还没有填写模型名');
  if (!resolveApiKey(target)) {
    return appError(
      'UPSTREAM_UNAUTHORIZED',
      '没有可用的 API Key。浏览器读不到系统环境变量，请直接填入 Key',
    );
  }
  return null;
}

/**
 * 解析凭据
 *
 * 优先级：**手填 Key > 构建期注入 > 空**
 *
 * 必须让用户知道的事实：**浏览器与桌面壳的渲染进程都读不到系统环境变量**，
 * 所以桌面端也无法直接读 `DEEPSEEK_API_KEY`。"环境变量名"的实际作用是在**构建期**
 * 把同名（或 `VITE_` 前缀）变量注入进来；要在运行期换 Key，请直接填值。
 */
function resolveApiKey(config: ProviderConnection): string {
  const manual = config.apiKey.trim();
  if (manual) return manual;

  const name = config.envVarName.trim();
  if (!name) return '';

  // 必须写成 `import.meta.env` 这个字面量：Vite 按字面文本替换，
  // 拆成中间变量再取值会在构建后什么都拿不到。
  const env: Record<string, unknown> = import.meta.env ?? {};
  const value = env[name] ?? env[`VITE_${name}`];
  return typeof value === 'string' ? value.trim() : '';
}

function parseExtraBody(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 采样参数 → 请求体字段
 *
 * **只下发用户显式设置过的字段**：没碰过的参数留给端点自己的默认值。
 * 全量下发会把上游默认值覆盖成我们的默认值 —— 用户明明没改却影响了结果。
 */
function toBodyParams(params: SamplingParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.stop && params.stop.length > 0) body.stop = params.stop;
  if (params.seed !== undefined) body.seed = params.seed;
  if (params.reasoningEffort !== undefined) body.reasoning_effort = params.reasoningEffort;
  return body;
}

function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  // 用户可能填到 /v1，也可能一路填到 /chat/completions；两种都认
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/* ────────────────────────── 超时与中止 ────────────────────────── */

/**
 * 把「用户中止」与「超时」合成一个 signal，并保留区分能力
 *
 * 不用 `AbortSignal.any`：那是较新的 API，自己组合几行就能覆盖全部目标环境，
 * 而且能明确知道到底是哪一边触发的。
 */
function combineSignals(
  user: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(user?.reason);
  user?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      user?.removeEventListener('abort', onAbort);
    },
  };
}

/* ────────────────────────── SSE 解析 ────────────────────────── */

/**
 * 逐行解析 SSE
 *
 * 按行而不是按 `\n\n` 切事件：换行可能是 `\n` 也可能是 `\r\n`，
 * 而网络分片**可能把一个换行符切成两半** —— 按行累积缓冲区天然免疫这个问题。
 * 非 `data:` 行（注释、心跳 `: ping`、`event:`）直接忽略。
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: FinishReason = 'stop';
  let sawDone = false;
  /**
   * 工具调用的累积区，按 `index` 分会话
   *
   * 协议把一次调用拆成很多帧：第一帧带 `id` 与函数名，后续帧只带
   * `arguments` 的碎片。所以 id/name 是**覆盖**（只出现一次），
   * arguments 必须**追加** —— 弄反了就会只拿到最后一个参数片段。
   */
  const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        if (payload === '[DONE]') {
          sawDone = true;
          break;
        }

        let chunk: RawChunk;
        try {
          chunk = JSON.parse(payload) as RawChunk;
        } catch {
          // 单帧坏掉不该让整轮失败：跳过它，继续读后面的
          continue;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          yield { kind: 'delta', text: delta.content };
        }
        // DeepSeek 的思考过程与正文分开给；单独发事件，界面可以选择性展示
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { kind: 'reasoning', text: delta.reasoning_content };
        }
        // 工具调用只累积、不立即 yield：碎片拼出来的 JSON 不完整，中途给出去没有意义
        if (Array.isArray(delta?.tool_calls)) {
          for (const raw of delta.tool_calls) {
            const index = typeof raw.index === 'number' ? raw.index : 0;
            const acc = pendingCalls.get(index) ?? { id: '', name: '', args: '' };
            if (typeof raw.id === 'string' && raw.id.length > 0) acc.id = raw.id;
            if (typeof raw.function?.name === 'string' && raw.function.name.length > 0) {
              acc.name = raw.function.name;
            }
            if (typeof raw.function?.arguments === 'string') acc.args += raw.function.arguments;
            pendingCalls.set(index, acc);
          }
        }
        if (chunk.usage) {
          yield { kind: 'usage', usage: toUsage(chunk.usage) };
        }
        if (choice?.finish_reason) {
          finishReason = toFinishReason(choice.finish_reason);
        }
      }
    }
  } finally {
    // 提前 break（用户中止）时也要释放底层连接，否则会一直读到超时
    void reader.cancel().catch(() => undefined);
  }

  /*
   * 工具调用在流结束时一次性给出
   *
   * 按 index 排序而不是按到达顺序：并行调用可能在同一个 chunk 里乱序出现，
   * 排序后顺序才稳定（同样的对话每次得到同样的调用次序，便于比对与调试）。
   */
  for (const [index, accumulated] of [...pendingCalls.entries()].sort((a, b) => a[0] - b[0])) {
    // 没有函数名的帧是残缺帧：宁可不调用，也不要执行一个"名字未知"的工具
    if (accumulated.name.length === 0) continue;
    const call: ToolCall = createToolCall(
      accumulated.id.length > 0 ? accumulated.id : `call-${index}`,
      accumulated.name,
      accumulated.args,
    );
    yield { kind: 'tool_call', call };
  }

  yield { kind: 'done', finishReason: signal.aborted ? 'aborted' : finishReason };
}

/* ────────────────────────── 请求字段构造 ────────────────────────── */

/**
 * 我们的消息 → 线上格式
 *
 * 工具相关字段必须**原样带上**：模型靠 `tool_calls` 认出"这是我刚才发起的调用"，
 * 靠 `tool_call_id` 把结果与调用配对。少任何一个，模型就会以为调用没发生过，
 * 于是把同一个工具再调一遍（表现为"AI 反复读同一个文件"）。
 */
function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls && message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            // arguments 必须是**字符串**而不是对象：协议如此规定，
            // 传对象会被判为非法请求
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  };
}

/* ────────────────────────── 响应字段归一化 ────────────────────────── */

/** 非流式响应的形状（只取我们要的两个字段） */
interface RawCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: Record<string, unknown>;
}

interface RawChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        index?: unknown;
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: Record<string, unknown>;
}

function toFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    default:
      return 'stop';
  }
}

/**
 * 用量归一化
 *
 * 各家的缓存字段名不一样，这里统一到 `cachedPromptTokens`：
 *  - DeepSeek：`prompt_cache_hit_tokens`（直接就是命中数）
 *  - OpenAI：`prompt_tokens_details.cached_tokens`
 * 都没有时**不填**，交给上层用公共前缀估算 —— 而不是写一个 0，
 * 因为"命中 0"和"不知道命中多少"是两件事。
 */
function toUsage(raw: Record<string, unknown>): TokenUsage {
  const promptTokens = numOr(raw.prompt_tokens, 0);
  const completionTokens = numOr(raw.completion_tokens, 0);
  const reasoningTokens = numOrUndef(
    (raw.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens,
  );
  const hit =
    numOrUndef(raw.prompt_cache_hit_tokens) ??
    numOrUndef(
      (raw.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    );

  return {
    promptTokens,
    completionTokens,
    totalTokens: numOr(raw.total_tokens, promptTokens + completionTokens),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(hit !== undefined ? { cachedPromptTokens: hit, cacheSource: 'provider' as const } : {}),
  };
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ────────────────────────── 错误映射 ────────────────────────── */

/**
 * HTTP 状态 → 稳定错误码
 *
 * 先看**响应体里的正文**：很多兼容网关把限流、余额不足、上下文超限都返回 400，
 * 只看状态码会把它们混成一句无用的"请求错误"。关键字命中失败才退回状态码兜底。
 */
async function httpError(response: Response): Promise<AppError> {
  let bodyText = '';
  try {
    bodyText = (await response.text()).slice(0, 600);
  } catch {
    bodyText = '';
  }

  const status = response.status;
  const lower = bodyText.toLowerCase();

  const code: ErrorCode =
    status === 401 || status === 403
      ? 'UPSTREAM_UNAUTHORIZED'
      : status === 402 || lower.includes('insufficient')
        ? 'UPSTREAM_INSUFFICIENT_BALANCE'
        : status === 429 || lower.includes('rate limit')
          ? 'UPSTREAM_RATE_LIMITED'
          : lower.includes('context length') || lower.includes('too long') || lower.includes('maximum context')
            ? 'UPSTREAM_CONTEXT_TOO_LONG'
            : status === 408 || status === 504
              ? 'UPSTREAM_TIMEOUT'
              : status >= 500
                ? 'UPSTREAM_SERVER_ERROR'
                : 'UPSTREAM_BAD_REQUEST';

  const message =
    code === 'UPSTREAM_UNAUTHORIZED'
      ? `认证失败（HTTP ${status}）。请检查 API Key 是否正确、是否与所选模型匹配`
      : code === 'UPSTREAM_INSUFFICIENT_BALANCE'
        ? `余额不足或未开通（HTTP ${status}）`
        : code === 'UPSTREAM_RATE_LIMITED'
          ? `触发限流（HTTP ${status}）。稍等片刻再试，或降低并发`
          : code === 'UPSTREAM_CONTEXT_TOO_LONG'
            ? '上下文超出模型上限。请缩短对话，或在设置里调低上下文上限'
            : code === 'UPSTREAM_TIMEOUT'
              ? `服务端响应超时（HTTP ${status}）`
              : code === 'UPSTREAM_SERVER_ERROR'
                ? `服务端错误（HTTP ${status}）`
                : `请求被拒绝（HTTP ${status}）`;

  return appError(code, message, {
    detail: bodyText,
    // 认证与余额问题重试必然失败；限流与服务端错误可以重试
    retryable: code === 'UPSTREAM_RATE_LIMITED' || code === 'UPSTREAM_SERVER_ERROR' || code === 'UPSTREAM_TIMEOUT',
  });
}

function transportError(error: unknown, userAborted: boolean): AppError {
  if (userAborted || (error instanceof Error && error.name === 'AbortError')) {
    return appError('ABORTED', userAborted ? '已停止生成' : '请求超时');
  }
  if (error instanceof TypeError) {
    // fetch 在网络层失败（跨域被拒、DNS、证书）统一抛 TypeError，正文没有可用信息
    return appError('NETWORK_ERROR', '连接失败：请检查接口地址是否正确、网络是否可达、是否被跨域策略拦截', {
      detail: error.message,
      retryable: true,
    });
  }
  return appError('UNKNOWN', '请求过程中发生未知错误', {
    detail: error instanceof Error ? error.message : String(error),
  });
}
