import { describe, expect, it } from 'vitest';
import { classifyStreamOutcome, type StreamOutcomeInput } from '@app/chat/streamOutcome';
import type { MessageSegment } from '@domain/entities/message';
import { appError } from '@shared/result';

/**
 * 定稿分类：成功 / 失败 / 用户按了停止
 *
 * 从 `ChatService.finalizeStream` 里抽出来的纯判定。三条规则以前只活在服务内部，
 * 只有端到端用例能碰到它们；而它们改坏的后果都指向同一种难看 —— **把错误写进正文**，
 * 那一行字会永久留在用户的消息里。
 */
const base: StreamOutcomeInput = {
  text: '正文',
  reasoning: '',
  settled: [],
  finishReason: 'stop',
  failure: null,
  aborted: false,
};

const classify = (patch: Partial<StreamOutcomeInput>) => classifyStreamOutcome({ ...base, ...patch });
const textSegment = (text: string): MessageSegment => ({ kind: 'text', text });

describe('classifyStreamOutcome', () => {
  it('正常结束：原样收下', () => {
    const outcome = classify({});

    expect(outcome).toEqual({ body: '正文', status: 'complete', finishReason: 'stop' });
  });

  it('上游失败：状态 error，并把失败说明**追进正文**（消息里没有别的字段能放它）', () => {
    const outcome = classify({
      failure: appError('UPSTREAM_SERVER_ERROR', '服务端错误（HTTP 500）', { retryable: true }),
    });

    expect(outcome.status).toBe('error');
    expect(outcome.finishReason).toBe('error');
    expect(outcome.body).toContain('服务端错误');
    expect(outcome.body.startsWith('正文')).toBe(true);
  });

  it('用户按了停止：状态是 aborted，正文里**不留任何痕迹**（自己按的不该看起来像故障）', () => {
    const outcome = classify({ aborted: true });

    expect(outcome).toEqual({ body: '正文', status: 'aborted', finishReason: 'aborted' });
  });

  it('停止时即使带着 ABORTED 的 error 事件，也不按失败处理 —— 这条最容易写坏', () => {
    // 中止时 provider 会抛一条 ABORTED 的 error 事件，它和其他失败一样落进 failure
    const outcome = classify({ failure: appError('ABORTED', '已停止生成') });

    expect(outcome.status).toBe('aborted');
    expect(outcome.body).toBe('正文');
    expect(outcome.body).not.toContain('⚠️');
  });

  it('只出了思考、正文是空的：补一句能照做的说明（否则界面上就是个空气泡）', () => {
    const outcome = classify({ text: '', reasoning: '想了很多' });

    expect(outcome.body).toContain('只输出了思考过程');
    expect(outcome.body).toContain('重新生成');
  });

  it('正文在 `settled` 里（续写轮、工具轮）**不算**"什么都没写"', () => {
    const outcome = classify({ text: '', reasoning: '想', settled: [textSegment('前面写过的内容')] });

    expect(outcome.body).not.toContain('只输出了思考过程');
  });

  it('失败与"只有思考"同时成立时，先说真正的失败', () => {
    const outcome = classify({
      text: '',
      reasoning: '想',
      failure: appError('UPSTREAM_TIMEOUT', '服务端响应超时（HTTP 504）'),
    });

    expect(outcome.body).toContain('超时');
    expect(outcome.body).not.toContain('只输出了思考过程');
  });
});
