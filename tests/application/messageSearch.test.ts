import { describe, expect, it } from 'vitest';
import { searchActivePath, searchVisibleAcrossConversations } from '@app/chat/messageSearch';
import { asToolCallId, type MessageId } from '@shared/ids';
import { asId, node } from '../helpers/messageNode';

/**
 * 正文搜索
 *
 * 这块逻辑决定"搜出几处、先后顺序、跳过去能不能看见"，而且它现在完全是纯函数，
 * 值得把规则逐条钉死 —— 之前它躺在 SQLite 适配器里，只能靠手点验证，
 * 结果就是"8 个词只搜出 4 处"这种问题得靠用户发现。
 */
describe('searchActivePath', () => {
  it('一处命中一条记录，而不是一条消息一条', () => {
    const path = [node('m1', { segments: [{ kind: 'text', text: 'workspace 与 workspace' }] })];

    const hits = searchActivePath(path, 'workspace');

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.occurrence)).toEqual([0, 1]);
    expect(hits.every((hit) => hit.messageId === 'm1')).toBe(true);
  });

  it('顺序按传入的路径（屏幕上从上到下），不是按时间倒序', () => {
    const path = [
      node('m1', { segments: [{ kind: 'text', text: '第一处 workspace' }] }),
      node('m2', { segments: [{ kind: 'text', text: '第二处 workspace' }] }),
    ];

    expect(searchActivePath(path, 'workspace').map((hit) => hit.messageId)).toEqual(['m1', 'm2']);
  });

  it('大小写不敏感', () => {
    const path = [node('m1', { segments: [{ kind: 'text', text: 'Workspace' }] })];
    expect(searchActivePath(path, 'WORKSPACE')).toHaveLength(1);
  });

  it('正文与思考过程都有时，只算正文，且不需要展开思考', () => {
    const path = [
      node('m1', {
        segments: [
          { kind: 'reasoning', text: '用户说的是 workspace 这个词' },
          { kind: 'text', text: '好的，workspace' },
        ],
      }),
    ];

    const hits = searchActivePath(path, 'workspace');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.reasoningOnly).toBe(false);
    expect(hits[0]?.occurrence).toBe(0); // 编号只算**会被渲染**的那一组
  });

  it('只有思考过程命中时标出来，供界面自动展开', () => {
    const path = [
      node('m1', {
        segments: [
          { kind: 'reasoning', text: '想想 workspace 这个名字' },
          { kind: 'text', text: '好了' },
        ],
      }),
    ];

    const hits = searchActivePath(path, 'workspace');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.reasoningOnly).toBe(true);
  });

  it('工具结果**不参与**搜索：它是机器输出，命中了也跳不到（渲染在悬浮面板里）', () => {
    const path = [
      node('m1', {
        segments: [
          { kind: 'text', text: '看一下文件' },
          {
            kind: 'tool_result',
            callId: asToolCallId('c1'),
            name: 'read_file',
            content: 'workspace 目录结构',
            isError: false,
          },
        ],
      }),
    ];

    expect(searchActivePath(path, 'workspace')).toEqual([]);
  });

  it('正文与工具结果都命中时，只出正文那一处', () => {
    const path = [
      node('m1', {
        segments: [
          { kind: 'text', text: '这个 workspace 挺好' },
          {
            kind: 'tool_result',
            callId: asToolCallId('c1'),
            name: 'read_file',
            content: 'workspace workspace',
            isError: false,
          },
        ],
      }),
    ];

    const hits = searchActivePath(path, 'workspace');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('挺好');
  });

  it('软删除的消息不参与搜索：它们不该出现在结果里', () => {
    const path = [
      node('m1', { segments: [{ kind: 'text', text: 'workspace' }], deletedAt: 123 }),
      node('m2', { segments: [{ kind: 'text', text: 'workspace' }] }),
    ];

    expect(searchActivePath(path, 'workspace').map((hit) => hit.messageId)).toEqual(['m2']);
  });

  it('空查询与纯空白返回空数组（不为"什么都没搜"跑一遍全文）', () => {
    const path = [node('m1', { segments: [{ kind: 'text', text: 'workspace' }] })];

    expect(searchActivePath(path, '')).toEqual([]);
    expect(searchActivePath(path, '   ')).toEqual([]);
  });

  it('片段的上下文取自**该处**位置，不是每条消息都截第一处', () => {
    const path = [
      node('m1', {
        segments: [{ kind: 'text', text: `${'甲'.repeat(60)}workspace${'乙'.repeat(60)}workspace尾部` }],
      }),
    ];

    const hits = searchActivePath(path, 'workspace');

    expect(hits).toHaveLength(2);
    expect(hits[0]?.snippet).not.toBe(hits[1]?.snippet);
    expect(hits[1]?.snippet).toContain('尾部');
  });
});

/**
 * 跨会话搜索的组装
 *
 * 它要解决的是那个最容易被忽略、后果又最明显的问题：**旧分支也在库里**。
 * 粗筛一定捞得到它们（正文确实存在），只有路径判定能把它们挡在外面 ——
 * 挡不住的后果就是用户按「下一处」跳到一片空白上。
 */
describe('searchVisibleAcrossConversations', () => {
  const candidate = (id: string, conversationId: string, text: string) =>
    node(id, { conversationId, segments: [{ kind: 'text', text }] });

  it('落在旧分支上的命中被滤掉', () => {
    const input = {
      candidates: [
        candidate('kept', 'c1', 'workspace 还在'),
        candidate('stale', 'c1', 'workspace 已被改掉'),
      ],
      // 只有 kept 在当前可见路径上
      pathByConversation: new Map<string, readonly MessageId[]>([['c1', [asId('kept')]]]),
    };

    expect(searchVisibleAcrossConversations(input, 'workspace').map((hit) => hit.messageId)).toEqual(
      ['kept'],
    );
  });

  it('会话按传入顺序（近者在前），会话内按上下顺序 —— 而不是粗筛的时间倒序', () => {
    const input = {
      candidates: [
        candidate('b2', 'c2', '这里 workspace'),
        candidate('a2', 'c1', '那里 workspace'),
        candidate('a1', 'c1', '开头 workspace'),
      ],
      pathByConversation: new Map<string, readonly MessageId[]>([
        ['c1', [asId('a1'), asId('a2')]],
        ['c2', [asId('b2')]],
      ]),
    };

    const hits = searchVisibleAcrossConversations(input, 'workspace');

    expect(hits.map((hit) => hit.messageId)).toEqual(['a1', 'a2', 'b2']);
    expect(hits.map((hit) => hit.conversationId)).toEqual(['c1', 'c1', 'c2']);
  });

  it('会话可见路径为空时它一条结果也不出', () => {
    const input = {
      candidates: [candidate('x', 'c9', 'workspace')],
      pathByConversation: new Map<string, readonly MessageId[]>([['c9', []]]),
    };

    expect(searchVisibleAcrossConversations(input, 'workspace')).toEqual([]);
  });
});
