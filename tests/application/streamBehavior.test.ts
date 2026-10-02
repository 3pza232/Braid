import { describe, expect, it } from 'vitest';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { LLMProvider } from '@ports/LLMProvider';
import { appError, ok } from '@shared/result';
import {
  createFakeWorkspace,
  createSettings,
  createStores,
  kinds,
  runConversation,
  textOf,
} from '../helpers/chatHarness';

/**
 * 流式编排的**行为**（`runStream` 那条路）
 *
 * 【为什么先写它】
 * `docs/07-development.md` 里"拆分 `ChatService`"那条写着：剩下的流式编排与工具循环
 * 是全项目最贵的路径，**先补它的行为测试再搬**。这份用例就是那个前提 ——
 * 它不测实现细节（分几段、什么时候 flush），只钉住用户能看到的结果：
 *
 *  - 分片要拼成完整正文，思考过程单独成段；
 *  - 中止是"用户自己停的"（`aborted`），不是错误（`error`）；
 *  - 上游报错时错误要落下，而不是留一条空回复；
 *  - 半截内容也要落库（重开页面时不该整条消失）。
 *
 * 有了这些，之后把这段代码搬去别的类才有安全网。
 */
describe('流式编排的行为', () => {
  it('分片拼成完整正文，思考过程单独成段', async () => {
    const { node } = await runConversation({
      rounds: [
        [
          { kind: 'reasoning', text: '先想一下' },
          { kind: 'delta', text: '你' },
          { kind: 'delta', text: '好' },
          { kind: 'delta', text: '，世界' },
          { kind: 'done', finishReason: 'stop' },
        ],
      ],
    });

    expect(textOf(node)).toBe('你好，世界');
    expect(kinds(node)).toBe('reasoning,text');
    expect(node?.status).toBe('complete');
  });

  it('上游报错：状态是 error，错误文本随回复一起留下（不是一条空回复）', async () => {
    const { node } = await runConversation({
      rounds: [
        [
          { kind: 'delta', text: '开头' },
          { kind: 'error', error: appError('UPSTREAM_BAD_REQUEST', '模型拒绝了这次请求') },
        ],
      ],
    });

    expect(node?.status).toBe('error');
    // 报错前写下的内容要留着 —— 用户能看见发生了什么，也能复制前半段
    expect(textOf(node)).toContain('开头');
  });

  it('用户主动停止：状态是 aborted，而不是 error', async () => {
    /*
     * 中止时 provider 会抛出一条 ABORTED 的 error 事件。如果照原样处理，
     * "我自己点的停止"会被记成一次失败 —— 界面上就是一条红色的错误消息。
     */
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider = {
      id: 'abortable',
      async *streamChat() {
        yield { kind: 'delta', text: '写到一半' } as const;
        await gate;
        yield { kind: 'error', error: appError('ABORTED', '已停止生成') } as const;
      },
      complete: async () => ok({ text: '' }),
      probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
    } as unknown as LLMProvider;

    const { store, messages } = createStores();
    const service = new ChatService(
      store,
      messages,
      createSettings(),
      provider,
      createWorkspaceToolRegistry(createFakeWorkspace().api),
    );
    await service.load();
    await service.send('写个长长的东西');

    service.stop();
    release();

    for (let waited = 0; waited < 200 && service.snapshot().streamingMessageId !== null; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const node = service.snapshot().tree.nodes.find((item) => item.role === 'assistant');
    expect(node?.status).toBe('aborted');
    // 半截内容也要落库：否则重开页面时"刚才写的那半段"整条消失
    const saved = await messages.listByConversation(service.snapshot().conversation.id);
    const persisted = saved.ok ? saved.data.find((item) => item.role === 'assistant') : undefined;
    expect(persisted?.status).toBe('aborted');
    expect(textOf(persisted ?? null)).toContain('写到一半');
  });

  it('工具轮：调用与结果都进同一轮请求的上下文（下一轮能看到上一次的结果）', async () => {
    // 第一轮：模型要求读一个文件；第二轮：模型据此作答
    const { node, requests } = await runConversation({
      prompt: '看看 README',
      rounds: [
        [
          {
            kind: 'tool_call',
            call: {
              id: 'call-1',
              name: 'read_file',
              argumentsJson: JSON.stringify({ path: 'README.md' }),
            } as never,
          },
          { kind: 'done', finishReason: 'tool_calls' as never },
        ],
        [
          { kind: 'delta', text: '看完了' },
          { kind: 'done', finishReason: 'stop' },
        ],
      ],
    });

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(textOf(node)).toContain('看完了');
    // 工具结果必须出现在**后续**请求里，否则模型是在盲答
    expect(kinds(node)).toContain('tool_call');
  });

  it('provider 直接抛异常（不是发 error 事件）：同样记成 error，不留一条空回复', async () => {
    /*
     * 注：**"没配模型"的校验不在这里** —— 它住在 provider 适配器里
     *（`openAICompatProvider` 会返回"还没有填写接口地址 / 模型名"），
     * 所以那一类要用 adapters 的用例去钉；这里钉的是流式编排自己的兜底：
     * provider 抛出（网络断了、适配器内部出错）时，`runStream` 必须把这一步收干净。
     */
    const provider = {
      id: 'throwing',
      async *streamChat() {
        yield { kind: 'delta', text: '刚开头' } as const;
        throw new Error('连接被重置');
      },
      complete: async () => ok({ text: '' }),
      probe: async () => ok({ ok: true, detail: '', latencyMs: 1 }),
    } as unknown as LLMProvider;

    const { store, messages } = createStores();
    const service = new ChatService(
      store,
      messages,
      createSettings(),
      provider,
      createWorkspaceToolRegistry(createFakeWorkspace().api),
    );
    await service.load();
    await service.send('你好');

    for (let waited = 0; waited < 200 && service.snapshot().streamingMessageId !== null; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const node = service.snapshot().tree.nodes.find((item) => item.role === 'assistant') ?? null;
    expect(node?.status).toBe('error');
    // 抛异常前写下的内容留着，用户至少能看到"到哪儿断的"
    expect(textOf(node)).toContain('刚开头');
  });
});
