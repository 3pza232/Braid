import { describe, expect, it } from 'vitest';
import { buildRoundRequest, type RoundRequestInput } from '@app/chat/roundRequest';
import { toolSpecTokensOf } from '@app/chat/messageAssembly';
import type { MessageSegment } from '@domain/entities/message';
import type { SamplingParams } from '@domain/value-objects/sampling';
import { estimateTokens } from '@domain/value-objects/usage';
import type { ProviderMessage, ProviderTool } from '@ports/LLMProvider';

/**
 * 「这一轮发什么」的组装
 *
 * 从 `ChatService.runStream` 里切出来的纯函数。它自己负责三条**顺序不能反**的规则，
 * 以前这些只活在几百行的缩进里，改之前得先把整段读懂：
 *  1. 已定稿的工具往来要并进消息（否则模型第二轮看不到自己调过什么，会重复调用）；
 *  2. 续写指令要在预算计算**之前**入列（否则算出来的预算与真实请求对不上）；
 *  3. 没有工具时**完全不发** `tools` 字段（个别网关把空数组判成非法参数）。
 * 外加一条：没裁剪时 `contextNote` 必须是 `null`，否则顶栏会显示一条假的"上下文被压缩"。
 */
const connection = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  requestTimeoutMs: 5000,
  extraBodyJson: '',
  model: 'test-model',
};

const base: RoundRequestInput = {
  history: [{ role: 'user', content: '第一问' }],
  settled: [],
  round: 0,
  continuationActive: false,
  continuationPrompt: '继续上文，不要重复',
  params: {} as SamplingParams,
  tools: [],
  contextBudget: 200_000,
  connection,
  signal: new AbortController().signal,
};

const build = (patch: Partial<RoundRequestInput>) => buildRoundRequest({ ...base, ...patch });

const asText = (plan: ReturnType<typeof buildRoundRequest>): string =>
  JSON.stringify(plan.request.messages);

const tool: ProviderTool = {
  type: 'function',
  function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
};

describe('buildRoundRequest', () => {
  it('第一轮：只发历史，续写指令不出现（它只在续写的后续轮次里才有意义）', () => {
    const plan = build({ continuationActive: true, round: 0 });

    expect(plan.request.messages).toHaveLength(1);
    expect(asText(plan)).not.toContain('继续上文');
  });

  it('续写轮：续写指令入列，但**只发进请求**（历史上仍然是用户原本那一条）', () => {
    const plan = build({ continuationActive: true, round: 1 });

    expect(plan.request.messages.map((m) => m.role)).toEqual(['user', 'user']);
    expect(plan.request.messages[1]?.content).toBe('继续上文，不要重复');
    // 历史本身没被改写：指令是每轮临时拼的，不会越积越多
    expect(base.history).toHaveLength(1);
  });

  it('没开续写时，第几轮都不加指令', () => {
    const plan = build({ continuationActive: false, round: 3 });
    expect(plan.request.messages).toHaveLength(1);
  });

  it('已定稿的内容要进消息：模型下一轮得看得见自己刚做了什么', () => {
    const settled: MessageSegment[] = [
      { kind: 'text', text: '我先读一下配置' },
      {
        kind: 'tool_call',
        call: { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a.md"}' } as never,
      },
      {
        kind: 'tool_result',
        callId: 'call-1' as never,
        name: 'read_file',
        content: '文件内容',
        isError: false,
      },
    ];

    const text = asText(build({ settled }));

    expect(text).toContain('我先读一下配置');
    expect(text).toContain('call-1'); // 调用与结果都带上了
    expect(text).toContain('文件内容');
  });

  it('没有工具时**完全不发** tools 字段（发空数组会被个别网关判成非法参数）', () => {
    const plan = build({ tools: [] });
    expect(plan.request.tools).toBeUndefined();
    expect(Object.keys(plan.request)).not.toContain('tools');
  });

  it('有工具时原样带上（不拷贝成别的形状）', () => {
    const plan = build({ tools: [tool] });
    expect(plan.request.tools).toEqual([tool]);
  });

  it('连接与模型信息原样透传（适配器是无状态的，全靠这里给）', () => {
    const plan = build({});
    expect(plan.request.baseUrl).toBe(connection.baseUrl);
    expect(plan.request.model).toBe(connection.model);
    expect(plan.request.signal).toBe(base.signal);
  });

  it('装得下时**什么都不动**：contextNote 是 null（顶栏不该显示假的压缩说明）', () => {
    const plan = build({});
    expect(plan.contextNote).toBeNull();
  });

  it('超出预算时**如实上报**，而不是偷偷丢历史（丢历史是压缩的职责）', () => {
    const many: ProviderMessage[] = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: '一段很长的历史内容。'.repeat(60),
    }));

    const plan = build({ history: many, contextBudget: 100 });

    expect(plan.contextNote).toContain('上下文超出设定上限');
    // 一条都没少：模型失忆比超限更糟，所以这里只报告、不擅自截断
    expect(plan.request.messages).toHaveLength(many.length);
  });

  it('超出预算时报出"超了多少"（调用方据此决定这一轮不发）', () => {
    const many: ProviderMessage[] = Array.from({ length: 50 }, () => ({
      role: 'user',
      content: '很长的历史内容。'.repeat(40),
    }));

    expect(build({}).overBudgetTokens).toBe(0);
    expect(build({ history: many, contextBudget: 100 }).overBudgetTokens).toBeGreaterThan(0);
    // 预算 <= 0 = "没有预算信息"：不拿一个未知的预算去拦人
    expect(build({ history: many, contextBudget: 0 }).overBudgetTokens).toBe(0);
  });

  it('过长的工具输出会被压成「头 + 尾」，并说明压了几条', () => {
    const huge = '工具输出的内容'.repeat(2000); // 远超压缩阈值
    const history: ProviderMessage[] = [
      { role: 'user', content: '读一下那个大文件' },
      { role: 'tool', content: huge },
    ];

    const plan = build({ history, contextBudget: 500 });
    const sent = plan.request.messages.find((message) => message.role === 'tool');

    expect(plan.contextNote).toContain('压缩了 1 条过长的工具输出');
    expect(sent?.content.length).toBeLessThan(huge.length);
    // 首尾都留着：压成"头 + 尾"而不是一刀切，模型才拿得到线索
    expect(sent?.content.startsWith(huge.slice(0, 20))).toBe(true);
    expect(sent?.content).toContain('需要更细的内容请重新调用该工具');
  });

  /*
   * 裁剪目标里要**扣掉 `tools` 那份 JSON**
   *
   * `messages` 里已经含系统提示词（第一条 system 消息，一直算着），但不含 `tools`
   * 字段的 JSON —— 那份按 OpenAI 兼容协议同样计入 `prompt_tokens`。不扣掉它，
   * `planContext` 会以为自己还装得下，真发出去的请求却超出预算。
   */
  it('预算里扣掉了 tools 那份 JSON：同一份历史，带了声明就装不下', () => {
    const history: ProviderMessage[] = [{ role: 'user', content: '甲'.repeat(300) }];
    const contentTokens = estimateTokens(history[0].content);
    const specTokens = toolSpecTokensOf([tool]);
    /*
     * 预算取"内容装得下、内容 + 声明装不下"的中间值
     *
     * 不写死数字：声明的篇幅取决于工具描述，改一句话就不该弄红这条用例。
     */
    const budget = contentTokens + Math.floor(specTokens / 2);

    // 没有工具声明：装得下 → 什么都不动（`contextNote` 必须是 null）
    expect(build({ history, contextBudget: budget }).contextNote).toBeNull();

    /*
     * 带上声明：总量越过扣完之后的预算 → 如实上报"超了多少"。
     * 修之前这里算成"装得下"，于是这一轮会带着超预算的请求发出去 ——
     * 而这正是闸门拦不住、上游才报错的那种情形。
     */
    expect(build({ history, tools: [tool], contextBudget: budget }).overBudgetTokens).toBeGreaterThan(0);
  });
});
