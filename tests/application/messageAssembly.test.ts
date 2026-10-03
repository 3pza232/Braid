import { describe, expect, it } from 'vitest';
import {
  FAILURE_MARK,
  appendFailure,
  buildProviderMessages,
  changedNodes,
  createNode,
  resolveUsage,
  serializePrompt,
} from '@app/chat/messageAssembly';
import { estimateTokens } from '@domain/value-objects/usage';
import { asId, node, tree } from '../helpers/messageNode';
import { appError } from '@shared/result';
import { asConversationId } from '@shared/ids';

/**
 * 消息装配：领域消息树 → 发给模型的消息序列
 *
 * 这段决定提示词的**逐字节形态**，而前缀缓存要求"与上一次请求从头完全一致" ——
 * 顺序抖动或多带一个字段都会让后面几万 token 的缓存失效，用户看不见，只会觉得变贵。
 * 所以这里既测"内容对不对"，也测"是不是稳定"。
 */

describe('createNode', () => {
  it('默认是一条已完成、未删除、无变体组的普通消息', () => {
    const created = createNode({
      conversationId: asConversationId('c1'),
      parentId: null,
      role: 'user',
      text: '你好',
      variantIndex: 0,
      now: 123,
    });

    expect(created.id.startsWith('msg-')).toBe(true);
    // 自己就是变体组的组长
    expect(created.variantOf).toBe(created.id);
    expect(created.status).toBe('complete');
    expect(created.segments).toEqual([{ kind: 'text', text: '你好' }]);
    expect(created.activeChildId).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBe(123);
    expect(created.updatedAt).toBe(123);
  });

  it('可选快照字段为空时**不出现**（避免把 undefined 写进数据库）', () => {
    const created = createNode({
      conversationId: asConversationId('c1'),
      parentId: null,
      role: 'assistant',
      text: '',
      variantIndex: 0,
      now: 1,
      modelRef: null,
      roleIdAtCreation: null,
      paramsSnapshot: undefined,
    });

    expect('modelRef' in created).toBe(false);
    expect('roleIdAtCreation' in created).toBe(false);
    expect('paramsSnapshot' in created).toBe(false);
  });

  it('有快照时原样带上，供"改参数后旧消息仍能解释自己"', () => {
    const created = createNode({
      conversationId: asConversationId('c1'),
      parentId: asId('p'),
      role: 'assistant',
      text: 'x',
      variantIndex: 2,
      now: 1,
      modelRef: 'deepseek-chat',
      roleIdAtCreation: 'role-1',
      paramsSnapshot: { temperature: 0.7 },
      status: 'streaming',
    });

    expect(created).toMatchObject({
      modelRef: 'deepseek-chat',
      roleIdAtCreation: 'role-1',
      paramsSnapshot: { temperature: 0.7 },
      status: 'streaming',
      variantIndex: 2,
      parentId: asId('p'),
    });
  });
});

describe('buildProviderMessages', () => {
  const chain = () => {
    // 系统提示 → u1 → a1，其中 a1 是"待生成"的那条占位
    const u1 = node('u1', { role: 'user', segments: [{ kind: 'text', text: '第一个问题' }] });
    const a1 = node('a1', {
      parentId: asId('u1'),
      role: 'assistant',
      segments: [{ kind: 'text', text: '' }],
    });
    u1.activeChildId = asId('a1');
    return { u1, a1, state: tree([u1, a1], 'u1') };
  };

  it('系统提示词非空时放在最前面', () => {
    const { state } = chain();
    const messages = buildProviderMessages('你是助手', state, asId('a1'));
    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(messages[1]).toEqual({ role: 'user', content: '第一个问题' });
  });

  it('系统提示词是空白时不占位（空 system 消息会被部分端点判为非法）', () => {
    const { state } = chain();
    expect(buildProviderMessages('   ', state, asId('a1'))).toHaveLength(1);
    expect(buildProviderMessages('', state, asId('a1'))).toHaveLength(1);
  });

  it('在待生成的那条回复之前停下 —— 否则模型会接着写自己那句空话', () => {
    const { state } = chain();
    const messages = buildProviderMessages('', state, asId('a1'));
    expect(messages.map((m) => m.content)).toEqual(['第一个问题']);
  });

  it('只走激活路径，不激活的分支不进请求', () => {
    const u1 = node('u1', { role: 'user', segments: [{ kind: 'text', text: '保留' }] });
    const kept = node('a1', { parentId: asId('u1'), segments: [{ kind: 'text', text: '在这条线上' }] });
    const otherBranch = node('a2', {
      parentId: asId('u1'),
      variantOf: asId('a1'),
      variantIndex: 1,
      segments: [{ kind: 'text', text: '另一条分支' }],
    });
    u1.activeChildId = asId('a1');

    const messages = buildProviderMessages('', tree([u1, kept, otherBranch], 'u1'), asId('ghost'));
    expect(messages.map((m) => m.content)).toContain('在这条线上');
    expect(messages.map((m) => m.content)).not.toContain('另一条分支');
  });

  it('路径上遇到已删除节点就停在那里', () => {
    const u1 = node('u1', { role: 'user', segments: [{ kind: 'text', text: '第一句' }] });
    const gone = node('a1', { parentId: asId('u1'), deletedAt: 5 });
    const later = node('u2', { parentId: asId('a1'), role: 'user', segments: [{ kind: 'text', text: '不该出现' }] });
    u1.activeChildId = asId('a1');
    gone.activeChildId = asId('u2');

    const messages = buildProviderMessages('', tree([u1, gone, later], 'u1'), asId('ghost'));
    expect(messages.map((m) => m.content)).toEqual(['第一句']);
  });

  it('环形引用不会死循环', () => {
    const a = node('a', { role: 'user', segments: [{ kind: 'text', text: 'a' }] });
    const b = node('b', { parentId: asId('a'), role: 'assistant', segments: [{ kind: 'text', text: 'b' }] });
    a.activeChildId = asId('b');
    b.activeChildId = asId('a');

    expect(buildProviderMessages('', tree([a, b], 'a'), asId('ghost'))).toHaveLength(2);
  });

  it('工具往来被还原成 assistant(tool_calls) + tool(...)，而不是丢掉', () => {
    // 丢了它们，模型在第二轮看不见自己刚调过什么，就会把同一个工具再调一遍
    const a1 = node('a1', {
      role: 'assistant',
      segments: [
        { kind: 'text', text: '我看看' },
        {
          kind: 'tool_call',
          call: { id: asId('call-1') as never, name: 'read_file', argumentsJson: '{"path":"a.txt"}' },
        },
        {
          kind: 'tool_result',
          callId: asId('call-1') as never,
          name: 'read_file',
          content: '文件内容',
          isError: false,
        },
      ],
    });

    const messages = buildProviderMessages('', tree([a1], 'a1'), asId('ghost'));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(messages[1].toolCallId).toBe(asId('call-1'));
    expect(messages[1].content).toBe('文件内容');
  });

  it('空树返回空数组', () => {
    expect(buildProviderMessages('', tree([]), asId('ghost'))).toEqual([]);
  });
});

describe('serializePrompt（缓存命中估算的基准串）', () => {
  it('同样的消息永远得到同样的串', () => {
    const messages = [
      { role: 'system' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
    ];
    expect(serializePrompt(messages)).toBe(serializePrompt(messages));
  });

  it('两条短消息与一条含换行的长消息不会撞成同一个串', () => {
    // 这就是不用换行做分隔符的原因：正文里本来就有换行，用换行当分隔会让前缀长度算错
    const two = serializePrompt([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    const one = serializePrompt([{ role: 'user', content: 'a\nb' }]);
    expect(two).not.toBe(one);
  });

  it('role 与 content 之间用不可见分隔符，不会与正文内容混淆', () => {
    const serialized = serializePrompt([{ role: 'user', content: 'x' }]);
    expect(serialized).toBe('user\u0000x');
  });

  it('条数不同则串不同（不能只比较拼接后的正文）', () => {
    const a = serializePrompt([{ role: 'user', content: 'ab' }]);
    const b = serializePrompt([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    expect(a).not.toBe(b);
  });
});

describe('appendFailure', () => {
  it('已有正文时另起一段追加，并去掉正文末尾多余空行', () => {
    const text = appendFailure('写了一半\n\n', appError('NETWORK_ERROR', '连接被重置'));
    expect(text).toBe('写了一半\n\n⚠️ 连接被重置');
  });

  it('一个字都没产出时只留标记', () => {
    expect(appendFailure('', appError('NETWORK_ERROR', '连接被重置'))).toBe(
      `${FAILURE_MARK} 连接被重置`,
    );
    expect(appendFailure('   ', appError('ABORTED', '已停止生成'))).toBe(`${FAILURE_MARK} 已停止生成`);
  });

  it('标记本身是醒目的符号，让用户能区分"系统说的"与"模型说的"', () => {
    expect(FAILURE_MARK).toBe('⚠️');
  });
});

describe('resolveUsage（三档可信度）', () => {
  it('服务端给了缓存字段就原样用，一个字都不改', () => {
    const usage = {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 80,
      cacheSource: 'provider' as const,
    };
    expect(resolveUsage(usage, 'x', 'y', 'z')).toBe(usage);
  });

  it('服务端给了用量但没有缓存字段：用量保留，只把缓存部分标为估算', () => {
    const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const resolved = resolveUsage(usage, '你好', '你好世界', '回答');

    expect(resolved?.promptTokens).toBe(100);
    expect(resolved?.completionTokens).toBe(10);
    expect(resolved?.cacheSource).toBe('estimated');
    // 估算命中数不得超过服务端给的 prompt 总量
    expect(resolved?.cachedPromptTokens).toBeLessThanOrEqual(100);
  });

  it('什么都没有时全部转为估算，并保证 总量 = 提示 + 补全', () => {
    const resolved = resolveUsage(undefined, '', '你好世界', 'abcdefgh');
    expect(resolved?.cacheSource).toBe('estimated');
    expect(resolved?.completionTokens).toBe(estimateTokens('abcdefgh'));
    expect(resolved?.totalTokens).toBe((resolved?.promptTokens ?? 0) + (resolved?.completionTokens ?? 0));
  });

  /*
   * 「什么都没给」这条路上，整份数字都是本地估的 → 必须打上 `estimated`
   *
   * 界面只认这一个字段（`MessageItem` 靠它决定要不要在数字前加 `≈`）。
   * 少了它，用户看到的就是一串**看起来精确**的数字 —— 而这条路正是被中止的请求、
   * 或端点没实现 `include_usage` 时走的，此时根本没有服务端数据可依据。
   */
  it('整份都是估算时要标记 `estimated`（否则界面不会显示 `≈`）', () => {
    const resolved = resolveUsage(undefined, '', '你好世界', 'abcdefgh');
    expect(resolved?.estimated).toBe(true);
  });

  it('但只要服务端给了用量就不标 `estimated` —— 那是真实数字', () => {
    const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const resolved = resolveUsage(usage, '你好', '你好世界', '回答');

    // 只有"命中数"是估的（`cacheSource` 负责标它），总量本身来自服务端
    expect(resolved?.cacheSource).toBe('estimated');
    expect(resolved?.estimated).toBeUndefined();
  });

  it('首次请求（没有上一次的 prompt）估出 0 命中，但不丢字段', () => {
    // 0 与"缺失"是两件事：界面要能显示 0%，而不是不显示
    const resolved = resolveUsage(undefined, '', '你好', '');
    expect(resolved?.cachedPromptTokens).toBe(0);
  });
});

describe('changedNodes（靠对象身份定位改动，不做深比较）', () => {
  it('引用没变的节点不算改动 —— 这是增量落库的依据', () => {
    const a = node('a');
    const b = node('b');
    expect(changedNodes([a, b], [a, b])).toEqual([]);
  });

  it('新对象才算改动', () => {
    const a = node('a');
    const patched = { ...a, updatedAt: 2 };
    expect(changedNodes([a], [patched])).toEqual([patched]);
  });

  it('只返回 after 里存在的节点（新增的也算改动）', () => {
    const a = node('a');
    const fresh = node('b');
    const changed = changedNodes([a], [a, fresh]);
    expect(changed).toEqual([fresh]);
  });

  it('被移除的节点不会被当成"改动"返回（已删除是软删，本就不该从 after 消失）', () => {
    const a = node('a');
    const b = node('b');
    expect(changedNodes([a, b], [a])).toEqual([]);
  });
});
