import { afterEach, describe, expect, it } from 'vitest';
import { createOpenAICompatProvider } from '@adapters/providers/openAICompatProvider';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { ChatRequest, ChatStreamEvent } from '@ports/LLMProvider';

/**
 * provider 的**错误映射**
 *
 * 之前所有 provider 用例都用 `status: 200` 的假 `fetch`，错误分支一条都没测过 ——
 * 而错误映射的分支比正常路径多得多，而且每条都直接决定用户看到什么话、能不能重试：
 *
 *  - 认证失败说"检查 API Key"，而限流说"稍等片刻再试" —— 说反了会让用户去改对的配置；
 *  - `retryable` 决定上层要不要自动重试：认证/余额重试必然失败，限流/服务端错误才值得重试；
 *  - 兼容网关常把"上下文超长""余额不足"都塞在 400 的正文里，只看状态码会混成
 *    一句无用的"请求被拒绝" —— 所以正文关键字优先于状态码。
 *
 * 这些都不可能靠"跑一次真实请求"验证（要真触发 401/402/429/504），只能这样钉住。
 */
const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

function installFetch(handler: () => Promise<Response> | Response): void {
  globalThis.fetch = (async () => handler()) as unknown as typeof fetch;
}

const request: ChatRequest = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  requestTimeoutMs: 5000,
  extraBodyJson: '',
  model: 'test-model',
  messages: [{ role: 'user', content: 'x' }],
  params: {} as SamplingParams,
  signal: new AbortController().signal,
};

/** 跑一次流式请求，返回第一个（也就是唯一那个）error 事件 */
async function firstError(patch: Partial<ChatRequest> = {}): Promise<ChatStreamEvent & { kind: 'error' }> {
  const provider = createOpenAICompatProvider();
  for await (const event of provider.streamChat({ ...request, ...patch })) {
    if (event.kind === 'error') return event;
  }
  throw new Error('没有收到 error 事件');
}

const respond = (status: number, body = ''): (() => Response) =>
  () => new Response(body, { status });

describe('HTTP 状态 → 错误码与可重试性', () => {
  it('401 / 403：认证失败，**不可重试**，并明确让用户去查 Key', async () => {
    for (const status of [401, 403]) {
      installFetch(respond(status));
      const error = await firstError();

      expect(error.error.code).toBe('UPSTREAM_UNAUTHORIZED');
      expect(error.error.retryable).toBe(false);
      expect(error.error.message).toContain('API Key');
    }
  });

  it('402：余额不足；重试没有意义', async () => {
    installFetch(respond(402));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_INSUFFICIENT_BALANCE');
    expect(error.error.retryable).toBe(false);
  });

  it('429：限流，**可重试**（这才是"稍等再试"的那一类）', async () => {
    installFetch(respond(429));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).toContain('限流');
  });

  it('408 / 504：超时', async () => {
    installFetch(respond(504));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(error.error.retryable).toBe(true);
  });

  it('5xx：服务端错误，可重试', async () => {
    installFetch(respond(500));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_SERVER_ERROR');
    expect(error.error.retryable).toBe(true);
  });

  it('其它 4xx：请求被拒绝，且**带上响应正文**（用户与开发者都需要它）', async () => {
    installFetch(respond(400, 'bad parameter: temperature'));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_BAD_REQUEST');
    expect(error.error.retryable).toBe(false);
    expect(error.error.detail).toContain('temperature');
  });
});

describe('正文关键字优先于状态码', () => {
  it('400 + 正文说上下文超长 → 上下文超长（并告诉用户怎么办）', async () => {
    installFetch(respond(400, 'This model maximum context length is 8192 tokens'));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_CONTEXT_TOO_LONG');
    expect(error.error.message).toContain('缩短对话');
  });

  it('503（本来会落进"服务端错误"）+ 正文说余额不足 → 余额不足', async () => {
    installFetch(respond(503, 'insufficient balance'));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_INSUFFICIENT_BALANCE');
  });

  it('429 + 正文只是普通错误 → 仍按状态码判为限流', async () => {
    installFetch(respond(429, 'slow down'));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_RATE_LIMITED');
  });
});

describe('传输层失败', () => {
  it('fetch 抛 TypeError（跨域/域名/DNS）→ 网络错误，可重试，并给出排查方向', async () => {
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await firstError();

    expect(error.error.code).toBe('NETWORK_ERROR');
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).toContain('接口地址');
  });

  it('AbortError 且**用户没按停止** → 判为超时', async () => {
    installFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await firstError();

    expect(error.error.code).toBe('ABORTED');
    expect(error.error.message).toBe('请求超时');
  });

  it('用户自己按了停止 → 也是 ABORTED，但说的是"已停止生成"（不该看着像出错）', async () => {
    installFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await firstError({ signal: AbortSignal.abort() });

    expect(error.error.code).toBe('ABORTED');
    expect(error.error.message).toBe('已停止生成');
  });

  it('其它异常 → UNKNOWN，并保留原始信息（不吞掉线索）', async () => {
    installFetch(() => {
      throw new Error('奇怪的失败');
    });
    const error = await firstError();

    expect(error.error.code).toBe('UNKNOWN');
    expect(error.error.detail).toContain('奇怪的失败');
  });
});

describe('发请求之前就能拦下的问题', () => {
  it('没填模型名 → 不发请求，直接给可读的校验错误', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;

    const error = await firstError({ model: '' });

    expect(called).toBe(false);
    expect(error.error.code).toBe('VALIDATION_ERROR');
  });

  it('「额外请求体」不是合法 JSON → 明确指到设置里那一项', async () => {
    installFetch(respond(200));
    const error = await firstError({ extraBodyJson: '{ 不是 JSON' });

    expect(error.error.code).toBe('VALIDATION_ERROR');
    expect(error.error.message).toContain('额外请求体');
  });

  it('200 但没有响应体 → 服务端错误（不是"成功但什么都没有"）', async () => {
    installFetch(() => new Response(null, { status: 200 }));
    const error = await firstError();

    expect(error.error.code).toBe('UPSTREAM_SERVER_ERROR');
    expect(error.error.message).toContain('没有返回流式内容');
  });
});
