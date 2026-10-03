import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_SYSTEM_PROMPT,
  buildCompressionMessages,
  describeNodes,
  estimateContextUsage,
  planCompression,
  summaryMessage,
} from '@domain/rules/contextCompression';
import { CHAR_TO_TOKEN_RATIO, estimateTokens } from '@domain/value-objects/usage';
import { asId, node } from '../helpers/messageNode';

/**
 * 上下文压缩的**规划**（不含模型调用）
 *
 * 这里决定"压哪一段"，是整条链路里最容易出错的一环：
 *  - 切错轮次 → 纪要里出现没有前文的半句话；
 *  - 漏掉最近几轮 → 用户刚说的话被压成了模糊记忆；
 *  - 把系统提示词也压了 → 人设与规则松动，模型开始不听话。
 */

/**
 * 一段够长的正文：确保超过"值得压缩"的门槛（域规则里的 `MIN_COVERED_TOKENS = 800`）
 *
 * 【长度为什么按估算系数现算】门槛量的是 token，而 token 是估算出来的。早先这里写死
 * 500 个汉字 —— 旧系数（×1.7）下约 850，刚好过线；估算一校准就掉到 350 左右，
 * "够长"变得不够长，`planCompression` 直接返回 `null`，一连串用例集体红。
 * 现在按当前系数换算，并留 1.5 倍余量。
 */
const LONG_BODY_CHARS = Math.ceil((800 * 1.5) / CHAR_TO_TOKEN_RATIO.cjk);
const longText = (label: string) => `${label}：${'甲'.repeat(LONG_BODY_CHARS)}`;

const turn = (index: number) => [
  node(`u${index}`, { role: 'user', segments: [{ kind: 'text', text: longText(`问题${index}`) }] }),
  node(`a${index}`, { role: 'assistant', segments: [{ kind: 'text', text: `回答${index}` }] }),
];

const path = (...indexes: number[]) => indexes.flatMap((index) => turn(index));

describe('estimateContextUsage', () => {
  it('统计激活路径 + 系统提示词 + 纪要 + 这次要发的内容', () => {
    const usage = estimateContextUsage({
      path: [node('u1', { role: 'user', segments: [{ kind: 'text', text: '甲'.repeat(100) }] })],
      summaryTokens: 50,
      systemPrompt: '你是助手',
      incoming: '继续',
    });

    expect(usage).toBe(estimateTokens('甲'.repeat(100)) + 50 + estimateTokens('你是助手') + estimateTokens('继续'));
  });

  it('已被纪要覆盖的节点不再计入 —— 它们真的不发送了', () => {
    const covered = node('u1', {
      role: 'user',
      segments: [{ kind: 'text', text: '甲'.repeat(500) }],
      contextFlags: { summarized: true },
    });
    const usage = estimateContextUsage({ path: [covered], summaryTokens: 30, systemPrompt: '' });

    expect(usage).toBe(30);
  });

  it('系统提示词要算进去 —— 漏掉它会让触发线形同虚设', () => {
    const withoutPrompt = estimateContextUsage({ path: [], summaryTokens: 0, systemPrompt: '' });
    const withPrompt = estimateContextUsage({
      path: [],
      summaryTokens: 0,
      systemPrompt: '甲'.repeat(1000),
    });

    expect(withoutPrompt).toBe(0);
    expect(withPrompt).toBe(estimateTokens('甲'.repeat(1000)));
  });

  /*
   * 请求里 `tools` 那份 JSON 也要算 —— 它是**系统提示词之外的第二份**工具信息。
   *
   * 打开工作区后，工具声明发了两次：提示词里一段文字说明（上面那条覆盖的是它），
   * 以及 `tools` 字段的 JSON（名字 / 描述 / 参数 schema）。后者按 OpenAI 兼容协议
   * 同样计入 `prompt_tokens`，而这里早先整份漏算 —— 实测 3 个工具约 353 token。
   *
   * 它在长对话里只占零点几个百分点，短对话上却能偏低七成，且方向是危险的那侧
   * （以为还有余量 → 请求直接撞上游上限）。**别把它并进 systemPrompt 去算**：
   * 那两句话是两份独立的内容，服务商两份都收。
   */
  it('请求里 tools 那份 JSON 也要算，而且不与系统提示词混为一谈', () => {
    const without = estimateContextUsage({ path: [], summaryTokens: 0, systemPrompt: '' });
    const withTools = estimateContextUsage({
      path: [],
      summaryTokens: 0,
      systemPrompt: '',
      toolSpecTokens: 353,
    });
    const both = estimateContextUsage({
      path: [],
      summaryTokens: 0,
      // 提示词里那份文字说明（一直有算）
      systemPrompt: '甲'.repeat(100),
      // tools 字段那份 schema（这次补上的）
      toolSpecTokens: 353,
    });

    expect(without).toBe(0);
    expect(withTools).toBe(353);
    // 两份是相加关系，不是"算一份就够"
    expect(both).toBe(estimateTokens('甲'.repeat(100)) + 353);
  });
});

describe('planCompression', () => {
  it('保留最近 N 轮原文，只压更早的', () => {
    const plan = planCompression({
      path: path(1, 2, 3, 4),
      keepRecentTurns: 2,
      alreadySummarized: new Set(),
    });

    expect(plan?.nodes.map((item) => item.id)).toEqual([asId('u1'), asId('a1'), asId('u2'), asId('a2')]);
    expect(plan?.coveredCount).toBe(4);
  });

  it('保留的轮数从最新往前算，不是从最早往后算', () => {
    const plan = planCompression({
      path: path(1, 2, 3),
      keepRecentTurns: 1,
      alreadySummarized: new Set(),
    });

    // 最近一轮（第三轮）必须留在原地
    expect(plan?.nodes.some((item) => item.id === asId('u3'))).toBe(false);
  });

  it('没有更早的历史时返回 null（不为了压而压）', () => {
    expect(
      planCompression({ path: path(1), keepRecentTurns: 3, alreadySummarized: new Set() }),
    ).toBeNull();
  });

  it('历史太短时返回 null —— 压缩本身也要花一次调用，不划算', () => {
    const short = [
      node('u1', { role: 'user', segments: [{ kind: 'text', text: '你好' }] }),
      node('a1', { role: 'assistant', segments: [{ kind: 'text', text: '你好' }] }),
      ...turn(2),
    ];

    expect(planCompression({ path: short, keepRecentTurns: 1, alreadySummarized: new Set() })).toBeNull();
  });

  it('系统消息不参与压缩（人设与规则必须逐字保留）', () => {
    const withSystem = [
      node('s1', { role: 'system', segments: [{ kind: 'text', text: longText('人设') }] }),
      ...path(1, 2),
    ];
    const plan = planCompression({ path: withSystem, keepRecentTurns: 1, alreadySummarized: new Set() });

    expect(plan?.nodes.some((item) => item.id === asId('s1'))).toBe(false);
  });

  it('已经压过的节点不再喂给压缩器（它们的内容已在旧纪要里）', () => {
    const plan = planCompression({
      path: path(1, 2, 3),
      keepRecentTurns: 1,
      alreadySummarized: new Set([asId('u1'), asId('a1')]),
    });

    expect(plan?.nodes.map((item) => item.id)).toEqual([asId('u2'), asId('a2')]);
  });

  it('目标长度有下限也有上限（太短装不下线索，太长等于没压）', () => {
    const huge = planCompression({
      path: path(1, 2, 3, 4, 5, 6, 7, 8),
      keepRecentTurns: 1,
      alreadySummarized: new Set(),
    });
    expect(huge?.targetTokens).toBeLessThanOrEqual(4000);
    expect(huge?.targetTokens).toBeGreaterThanOrEqual(300);
  });
});

describe('describeNodes（给压缩器看的一段对话）', () => {
  it('用角色标签分行，工具结果只留开头', () => {
    const described = describeNodes([
      node('u1', { role: 'user', segments: [{ kind: 'text', text: '看看这个文件' }] }),
      node('a1', {
        role: 'assistant',
        segments: [
          { kind: 'tool_result', callId: asId('c1') as never, name: 'read_file', content: '乙'.repeat(1000), isError: false },
        ],
      }),
    ]);

    expect(described).toContain('用户：看看这个文件');
    expect(described).toContain('工具 read_file');
    // 工具返回不誊抄，只留一点痕迹
    expect(described.length).toBeLessThan(400);
  });

  it('工具的原始 JSON 不出现（压缩器要读内容，不是协议）', () => {
    const described = describeNodes([
      node('a1', {
        role: 'assistant',
        segments: [
          { kind: 'tool_call', call: { id: asId('c1') as never, name: 'read_file', argumentsJson: '{"path":"secret.json"}' } },
          { kind: 'text', text: '我读一下' },
        ],
      }),
    ]);

    expect(described).not.toContain('secret.json');
    expect(described).toContain('我读一下');
  });
});

describe('给压缩器的提示词', () => {
  it('明确只做记录：不许续写、不许评价、不确定就省略', () => {
    // 压缩最容易出的两个问题都来自"模型太想帮忙"：凭空补情节、写读后感
    expect(COMPRESSION_SYSTEM_PROMPT).toContain('不要续写');
    expect(COMPRESSION_SYSTEM_PROMPT).toContain('不要评价');
    expect(COMPRESSION_SYSTEM_PROMPT).toContain('宁可省略');
  });

  it('要求保留人物设定、用户偏好、已完成动作与未解决线索', () => {
    for (const keyword of ['人物', '偏好', '结果', '未解决']) {
      expect(COMPRESSION_SYSTEM_PROMPT).toContain(keyword);
    }
  });

  it('有旧纪要时必须一起喂进去 —— 否则第二次压缩会把更早的历史弄丢', () => {
    const messages = buildCompressionMessages({
      transcript: '新的历史',
      previousSummary: '更早的纪要',
      targetTokens: 500,
    });
    const all = messages.map((message) => message.content).join('\n');

    expect(all).toContain('更早的纪要');
    expect(all).toContain('新的历史');
    expect(all).toContain('500');
  });

  it('第一次压缩时不出现"此前纪要"那段', () => {
    const all = buildCompressionMessages({
      transcript: '新的历史',
      previousSummary: null,
      targetTokens: 500,
    })
      .map((message) => message.content)
      .join('\n');

    expect(all).not.toContain('此前的纪要');
  });
});

describe('纪要回到对话里的形态', () => {
  it('是 system 消息，且明确说"这是已经发生过的事"', () => {
    // 不说清就会变成"刚有人给我一段总结"，模型会把它当成新指令
    const message = summaryMessage('用户想要一个温柔的角色。');

    expect(message.role).toBe('system');
    expect(message.content).toContain('用户想要一个温柔的角色。');
    expect(message.content).toContain('已经发生');
  });
});
