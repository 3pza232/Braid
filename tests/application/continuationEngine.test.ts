import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '@ports/LLMProvider';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@domain/value-objects/appSettings';
import {
  createFakeProvider,
  createFakeWorkspace,
  createSettings,
  createStores,
  kinds,
  runConversation,
  textOf,
} from '../helpers/chatHarness';

/** 让新会话默认落在「中」档、且字数下限调小到测试里几轮就能达到 */
function continuationSettings(target: number): AppSettings {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.defaultWritingMode = 'medium';
  settings.continuationPrompt = '继续写';
  settings.writingModes.medium = {
    ...settings.writingModes.medium,
    minOutputChars: target,
    stallLimit: 2,
  };
  /*
   * 单轮输出上限是**全局共享**的采样参数（界面在 设置 → 上下文），不再是档位字段。
   * 这里取 500：它同时是"每次请求的 max_tokens"与"上下文预算里的输出预留"，
   * 下面几条关于预算的断言正是照这个数写的。
   */
  settings.sampling = { ...settings.sampling, maxTokens: 500 };
  return settings;
}

const chunkRound = (text: string): ChatStreamEvent[] => [
  { kind: 'delta', text },
  { kind: 'done', finishReason: 'stop' },
];

/**
 * 一轮：正文 + **写死的**用量
 *
 * 写死是为了让"整条消息的总和"能直接算出来 —— 服务端返回多少就是多少，
 * 不用跟着本地估算的 token 数走（否则断言只能写成"大概变大"）。
 */
const usageRound = (text: string, total: number): ChatStreamEvent[] => [
  { kind: 'delta', text },
  { kind: 'usage', usage: { promptTokens: total - 10, completionTokens: 10, totalTokens: total } },
  { kind: 'done', finishReason: 'stop' },
];

/** 「每轮询问」档位（下限调得很高，保证"还能再写"始终成立） */
function askSettings(target = 10_000): AppSettings {
  const settings = continuationSettings(target);
  settings.writingModes.medium = { ...settings.writingModes.medium, continuation: 'ask' };
  return settings;
}

/** 等这一次生成真的收工（收尾落库发生在流结束之后，所以要轮询状态而不是掐时间） */
async function waitIdle(service: { snapshot: () => { streamingMessageId: unknown } }) {
  for (let waited = 0; waited < 600; waited += 1) {
    if (service.snapshot().streamingMessageId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('续写引擎', () => {
  it('没到下限就自动续写，全部内容累积在同一个气泡里', async () => {
    // 每轮 12 字，下限 20 → 第 2 轮后 24 字达标
    const { requests, node, nodes } = await runConversation({
      settings: continuationSettings(20),
      rounds: [chunkRound('一二三四五六七八九十十一'), chunkRound('一二三四五六七八九十十一')],
    });

    expect(requests.length).toBe(2);
    expect(textOf(node).length).toBe(24);
    // 一个气泡：只有 user + assistant 两个节点，续写没有拆成新消息
    expect(nodes).toHaveLength(2);
    /*
     * "续了几轮 / 有没有写到下限"以前各有一个字段记录（`continuationIndex` / `reachedTarget`），
     * 已随迁移 v9 删掉：这两件事**都能从用户看得见的东西推出来**，这样断言反而更贴近实情 ——
     *  - 续了几轮 = 有几段正文（每续一轮固化一段）→ `text,text`；
     *  - 有没有写到下限 = 它是**因为达标而停**，而不是撞上哪一道上限（没有任何"上限"提示）。
     */
    expect(kinds(node)).toBe('text,text');
    expect(textOf(node)).not.toContain('上限');
  });

  it('续写提示词只发进请求，不入库也不上屏', async () => {
    const { requests, nodes } = await runConversation({
      settings: continuationSettings(20),
      rounds: [chunkRound('一二三四五六七八九十十一'), chunkRound('一二三四五六七八九十十一')],
    });

    const second = requests[1]?.messages ?? [];
    const last = second[second.length - 1];
    expect(last['role']).toBe('user');
    expect(last['content']).toBe('继续写');
    // 第一轮请求不带续写指令
    const first = requests[0]?.messages ?? [];
    expect(first.some((message) => message['content'] === '继续写')).toBe(false);
    // 对话里也只有一条用户消息（发出去的那句），没有续写指令的痕迹
    expect(nodes.filter((node) => node.role === 'user')).toHaveLength(1);
  });

  it('续写每一轮都用**全局共享**的单轮输出上限（不再有"档位专属的 max_tokens"）', async () => {
    /*
     * 这一条替换了早先"每轮用档位里配的那个 max_tokens"的用例。
     * 那个档位字段已经并进采样参数：普通对话与短/中/长三个档位共享同一个
     * 「单轮输出上限」（设置 → 上下文），所以每一轮请求里的 max_tokens
     * 都应当等于它 —— 用户再也不用猜"我改的是哪一个"。
     */
    const { requests } = await runConversation({
      settings: continuationSettings(20),
      rounds: [chunkRound('一二三四五六七八九十十一'), chunkRound('一二三四五六七八九十十一')],
    });
    // continuationSettings 把采样里的 maxTokens 设成了 500
    expect(requests[0]?.params?.maxTokens).toBe(500);
    expect(requests[1]?.params?.maxTokens).toBe(500);
  });

  it('达到下限就停，不会多写', async () => {
    // 第 1 轮就写了 30 字（下限 20）→ 只有一轮
    const { requests } = await runConversation({
      settings: continuationSettings(20),
      rounds: [chunkRound('一'.repeat(30))],
    });
    expect(requests.length).toBe(1);
  });

  /*
   * ── 「每轮询问」 ──
   *
   * 这一档此前是**空转的**：界面给了三个选项，而实现只区分"是不是 off"，
   * 于是它与「自动续写」跑的是同一段逻辑（用户反馈："每轮询问似乎没有效果"）。
   * 下面几条把它现在应有的行为钉住。
   */
  it('「每轮询问」：写完一轮就停下等用户点头，不自己接着写', async () => {
    const { requests, node, service } = await runConversation({
      settings: askSettings(),
      rounds: [chunkRound('第一轮写了一段'), chunkRound('第二轮又写了一段')],
    });

    // 只发了一次请求：第二轮的脚本还在，没被用到
    expect(requests.length).toBe(1);
    expect(textOf(node)).toBe('第一轮写了一段');
    // "等你继续"挂在这条消息上 —— 界面据此长出「继续写」按钮
    expect(service.snapshot().continuableMessageId).toBe(node?.id ?? null);
    // 它**不是**撞上限停的：那句"撞上限"的收尾语不该出现（那是另一条路径）
    expect(textOf(node)).not.toContain('上限');
  });

  it('「每轮询问」：点「继续写」后接着往下写，而且不新建消息', async () => {
    const run = await runConversation({
      settings: askSettings(),
      rounds: [chunkRound('第一轮写了一段'), chunkRound('第二轮又写了一段')],
    });
    const id = run.node?.id ?? null;
    expect(id).not.toBeNull();

    await run.service.continueWriting(id as never);
    await waitIdle(run.service);

    expect(run.requests.length).toBe(2);
    // 同一个气泡：新内容累积在**同一条**消息里（新建消息会让"连续写"的观感断掉）
    expect(run.service.snapshot().tree.nodes).toHaveLength(2);
    const node = run.service.snapshot().tree.nodes.find((item) => item.id === id) ?? null;
    expect(textOf(node)).toBe('第一轮写了一段第二轮又写了一段');
    // 下限还远没到 → 继续挂着邀请，可以一轮轮点下去
    expect(run.service.snapshot().continuableMessageId).toBe(id);
  });

  it('「继续写」的用量是**整条消息的总和**，不是最后一批（否则数字偏小）', async () => {
    /*
     * 【这条钉的是一处真的算错过的地方】
     * 「继续写」是**新开一次 runStream**（把已写段与已花用量当种子）。
     * 而定稿是"覆盖这条消息的 usage" —— 对"发送 / 重新生成"（新节点）都对，
     * 只有这条追加路径会吃掉前面几轮：连点两次之后，显示的就只剩最后一批。
     */
    const run = await runConversation({
      settings: askSettings(),
      // 三段各自 100 / 200 / 300
      rounds: [usageRound('第一段', 100), usageRound('第二段', 200), usageRound('第三段', 300)],
    });
    const id = run.node?.id ?? null;
    const usageOf = () =>
      run.service.snapshot().tree.nodes.find((node) => node.id === id)?.usage ?? null;

    expect(usageOf()?.totalTokens).toBe(100);

    await run.service.continueWriting(id as never);
    await waitIdle(run.service);
    expect(usageOf()?.totalTokens).toBe(300); // 100 + 200

    await run.service.continueWriting(id as never);
    await waitIdle(run.service);
    // 100 + 200 + 300 —— 覆盖式写法在这里只会留下 300
    expect(usageOf()?.totalTokens).toBe(600);
    // 输入/输出也分别是各段之和，不是最后一段的
    expect(usageOf()?.completionTokens).toBe(30);
  });

  it('「每轮询问」：续写时把**已写的内容**发给模型（否则它会从头再写一遍）', async () => {
    const run = await runConversation({
      settings: askSettings(),
      rounds: [chunkRound('前情提要到此为止'), chunkRound('后面接着写')],
    });

    await run.service.continueWriting(run.node?.id as never);
    await waitIdle(run.service);

    /*
     * 已定稿的段会被当作"上一轮的产出"交给模型（`appendSegmentsToTranscript`），
     * 因此第二次请求里必须能看到第一轮写出来的字。
     * 少了它，模型会以为这是新的一轮，于是把开头重写一遍。
     */
    expect(JSON.stringify(run.requests[1]?.messages ?? [])).toContain('前情提要到此为止');
  });

  it('「关闭」：一轮就结束，也不会挂出任何邀请', async () => {
    const settings = askSettings();
    settings.writingModes.medium = { ...settings.writingModes.medium, continuation: 'off' };

    const { requests, node, service } = await runConversation({
      settings,
      rounds: [chunkRound('一次写完'), chunkRound('不该被用到')],
    });

    expect(requests.length).toBe(1);
    expect(textOf(node)).toBe('一次写完');
    expect(service.snapshot().continuableMessageId).toBeNull();
  });

  it('用户选择**直接发下一条**而不是点继续：邀请作废（不留一个指向旧消息的按钮）', async () => {
    const run = await runConversation({
      settings: askSettings(),
      rounds: [chunkRound('第一轮'), chunkRound('第二轮'), chunkRound('新的一句')],
    });
    const firstId = run.node?.id ?? null;
    expect(run.service.snapshot().continuableMessageId).toBe(firstId);

    await run.service.send('换一个话题');
    await waitIdle(run.service);

    /*
     * 邀请**转到新的那条**上，旧的那条不再挂着按钮 ——
     * 否则界面上会出现两个「继续写」，用户不知道该点哪个。
     */
    const latest = run.service.snapshot().tree.nodes
      .filter((node) => node.role === 'assistant')
      .at(-1);
    expect(run.service.snapshot().continuableMessageId).not.toBe(firstId);
    expect(run.service.snapshot().continuableMessageId).toBe(latest?.id ?? null);
  });

  it('普通对话不受影响：一次请求就是一次回复', async () => {
    const { requests, node } = await runConversation({
      rounds: [chunkRound('普通回复')],
    });
    expect(requests.length).toBe(1);
    expect(kinds(node)).toBe('text');
    expect(textOf(node)).toBe('普通回复');
  });

  it('模型原地打转（连续空轮）时按停顿上限中止，不会永远跑下去', async () => {
    const emptyRound: ChatStreamEvent[] = [{ kind: 'delta', text: '' }, { kind: 'done', finishReason: 'stop' }];
    const { requests, node } = await runConversation({
      settings: continuationSettings(10_000),
      rounds: [emptyRound, emptyRound, emptyRound],
    });
    // 连续 2 轮空转（stallLimit=2）→ 第 2 轮就中止，不会发起第 3 次
    expect(requests.length).toBe(2);
    // 中止是**安静的**：一个字的正文都没有，也不往气泡里塞任何"上限"说明
    expect(textOf(node)).toBe('');
  });

  it('开了自动压缩：续写走到触发线就**自己压一次再接着写**，不必停下等用户', async () => {
    const chunk = (label: string) => `${label}内容`.repeat(60); // ≈600 字 ≈ 520 token
    const waitIdle = async (service: { snapshot: () => { streamingMessageId: unknown } }) => {
      for (let waited = 0; waited < 600; waited += 1) {
        if (service.snapshot().streamingMessageId === null) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    /**
     * 预算 4000、触发线 80% = 3200。
     *
     * 刻意这样摆（每一步都是为了**让压缩只能发生在生成过程中**）：
     *  - 这里没有系统提示词要算：`config.systemPrompt` 只来自「会话 → 角色」两层，
     *    两者都没设时是空串（全局那份不走这个口径），所以数只落在"历史 + 已写正文"上；
     *  - 历史两轮 ≈2080 token，加本次提问 ≈2600 —— **低于触发线**，
     *    所以发送前那道闸门不会压（否则就分不清是"发送前压的"还是"轮间压的"了）；
     *  - `keepRecentMessages: 1`：只留最近一轮原文，更早的两轮才是可压的；
     *  - 每轮续写 ≈520 token，第 1 轮之后就越过 3200 → 轮间压缩。
     */
    const settingsFor = (compression: 'auto' | 'off'): AppSettings => {
      const settings = continuationSettings(100_000);
      // 预算 = 4000 − 500（单轮输出上限，见 continuationSettings）
      settings.context = {
        ...settings.context,
        maxContextTokens: 4000,
        keepRecentMessages: 1,
        compression,
        compressAt: 0.8,
      };
      return settings;
    };

    const run = (compression: 'auto' | 'off') =>
      runConversation({
        settings: settingsFor(compression),
        // 前两轮回答"垫历史"的两条，其余留给续写
        rounds: [
          chunkRound(chunk('历史一')),
          chunkRound(chunk('历史二')),
          ...Array.from({ length: 20 }, (_, index) => chunkRound(chunk(`第${index + 1}段`))),
        ],
        beforeSend: async (service) => {
          await service.send(chunk('历史一'));
          await waitIdle(service);
          await service.send(chunk('历史二'));
          await waitIdle(service);
        },
      });

    const auto = await run('auto');
    const off = await run('off');
    const autoTexts = auto.requests.map((request) => JSON.stringify(request.messages));

    // 生成**过程中**压过（不是发送前压的）
    expect(auto.compressions.length).toBeGreaterThanOrEqual(1);
    const firstContinuation = autoTexts.findIndex((text) => text.includes('继续写'));
    expect(firstContinuation).toBeGreaterThan(0);
    expect(autoTexts.slice(0, firstContinuation).some((text) => text.includes('【测试纪要】'))).toBe(
      false,
    );
    // 压完的结果真的用上了：后续请求里带的是纪要
    expect(autoTexts.at(-1)).toContain('【测试纪要】');

    // 效果：同一个场景，开了自动压缩能写得远得多
    expect(off.compressions).toHaveLength(0);
    expect(auto.requests.length).toBeGreaterThan(off.requests.length);
    // 而且收得干净（最后是"超预算主动停"，不是被上游拒）
    const autoMessage = auto.nodes.filter((item) => item.role === 'assistant').at(-1) ?? null;
    expect(autoMessage?.status).toBe('complete');
    expect(textOf(autoMessage)).not.toContain('⚠️');
  });

  it('上下文到顶（且没开自动压缩）：主动收在上一轮，而不是让上游拒一次', async () => {
    const settings = continuationSettings(100_000);
    /*
     * 预算 2000（2500 − 500）、每轮约 600 字 ≈ 520 token —— 第 4 轮左右就会顶到上限。
     * 轮数脚本给足（20 轮），这样"停"只可能是**主动停**，不是脚本用完导致的。
     */
    settings.context = {
      ...settings.context,
      maxContextTokens: 2500,
      compression: 'off',
    };
    const chunk = (label: string) => `${label}内容`.repeat(60);

    const { requests, node } = await runConversation({
      settings,
      rounds: Array.from({ length: 20 }, (_, index) => chunkRound(chunk(`第${index + 1}段`))),
    });

    // 早早停住：没有把 20 轮跑完
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThanOrEqual(6);
    /*
     * 关键一条：**干净地停下**（complete），不是被上游拒成 error ——
     * 后者会把上游的错误文案追进正文，用户在自己的小说里读到一段报错。
     */
    expect(node?.status).toBe('complete');
    expect(textOf(node)).not.toContain('⚠️');
    // 写过的内容都在，并且告诉用户下一步能做什么（与发送前那道闸门同一套说法）
    expect(textOf(node)).toContain('第1段内容');
    expect(textOf(node)).toContain('上下文已到设定上限');
    expect(textOf(node)).toContain('「继续」');
  });

  it('store / workspace / tools 的装配与门禁仍然成立（工具循环回归）', async () => {
    const { store, messages } = createStores();
    const workspace = createFakeWorkspace();
    const tools = createFakeProvider([
      [
        { kind: 'delta', text: '我来写文件。' },
        {
          kind: 'tool_call',
          call: {
            id: 'c1' as never,
            name: 'write_file',
            argumentsJson: JSON.stringify({ path: '小说/第一章.txt', content: '正文' }),
            parsed: { path: '小说/第一章.txt', content: '正文' },
          },
        },
        { kind: 'done', finishReason: 'tool_calls' },
      ],
      [chunkRound('写好了。')[0], { kind: 'done', finishReason: 'stop' }],
    ]);

    // 直接复用 harness 的最小装配，验证"未授权时一个字节都不落盘"
    workspace.writeGranted = false;
    const { ChatService } = await import('@app/chat/ChatService');
    const { createWorkspaceToolRegistry } = await import('@app/tools/workspaceToolRegistry');
    const service = new ChatService(
      store,
      messages,
      createSettings(),
      tools.provider,
      createWorkspaceToolRegistry(workspace.api),
    );
    await service.load();
    await service.send('帮我写文件');
    for (let waited = 0; waited < 600; waited += 1) {
      if (service.snapshot().streamingMessageId === null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(workspace.writes).toHaveLength(0);
    expect(workspace.attempts).toHaveLength(1);
    const node = service.snapshot().tree.nodes.find((item) => item.role === 'assistant');
    const result = node?.segments.find((segment) => segment.kind === 'tool_result');
    expect(result?.kind === 'tool_result' && result.isError).toBe(true);
    expect(textOf(node ?? null)).toContain('写好了');
  });
});
