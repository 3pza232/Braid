import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_SYSTEM_PROMPT,
  buildCompressionMessages,
  describeNodes,
  estimateContextUsage,
  planCompression,
  summaryMessage,
} from '@domain/rules/contextCompression';
import { estimateTokens } from '@domain/value-objects/usage';
import { asId, node } from '../helpers/messageNode';

/**
 * 上下文压缩的**规划**（不含模型调用）
 *
 * 这里决定"压哪一段"，是整条链路里最容易出错的一环：
 *  - 切错轮次 → 纪要里出现没有前文的半句话；
 *  - 漏掉最近几轮 → 用户刚说的话被压成了模糊记忆；
 *  - 把系统提示词也压了 → 人设与规则松动，模型开始不听话。
 */

/** 一段够长的正文（约 850 token），确保超过"值得压缩"的门槛 */
const longText = (label: string) => `${label}：${'甲'.repeat(500)}`;

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
