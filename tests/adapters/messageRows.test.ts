import { describe, expect, it } from 'vitest';
import { serializeSegments } from '@adapters/storage/sqlite/messageRows';
import type { MessageSegment } from '@domain/entities/message';
import { createToolCall } from '@domain/entities/message';
import { asToolCallId } from '@shared/ids';
import { node } from '../helpers/messageNode';

/**
 * `segments_json` 的序列化
 *
 * 这个字段是正文的**唯一**存放处，所以这里唯一重要的性质是：
 * 手工拼出来的字符串必须与 `JSON.stringify` **逐字节相同** ——
 * 差一个字符就是静默的数据损坏（写进去读不回来，或者读出来少一段）。
 *
 * 之所以要手工拼，是为了按**段对象**缓存：流式期间每 1.5s 落库一次，
 * 未变的长段（工具结果上限 2 万字）不该被反复序列化。
 */
describe('serializeSegments', () => {
  const sameAsJson = (segments: MessageSegment[]) => {
    expect(serializeSegments(segments)).toBe(JSON.stringify(segments));
  };

  it('空的段落数组', () => {
    sameAsJson([]);
  });

  it('单个文本段', () => {
    sameAsJson([{ kind: 'text', text: '你好，世界' }]);
  });

  it('含需要转义的字符（引号 / 换行 / 反斜杠 / 制表符）', () => {
    sameAsJson([{ kind: 'text', text: 'a"b\\c\nd\te\r\u0000' }]);
  });

  it('混合各类段（思考 + 正文 + 工具调用 + 工具结果）', () => {
    sameAsJson([
      { kind: 'reasoning', text: '先想一下' },
      { kind: 'text', text: '正文' },
      { kind: 'tool_call', call: createToolCall('c1', 'read_file', '{"path":"a.txt"}') },
      {
        kind: 'tool_result',
        callId: asToolCallId('c1'),
        name: 'read_file',
        content: '{\n  "long": "tool output"\n}',
        isError: false,
      },
    ]);
  });

  it('含 unicode 与代理对（emoji / 中文 / 组合字符）', () => {
    sameAsJson([
      { kind: 'text', text: '👩‍💻 déjà vu — café 😀 𠀋' },
      { kind: 'reasoning', text: '思考\u2028分隔' },
    ]);
  });

  it('真实节点的段落（与落库路径用同一份数据）', () => {
    const value = node('m1', {
      segments: [
        { kind: 'text', text: '第一段' },
        { kind: 'text', text: '第二段' },
      ],
    });

    sameAsJson([...value.segments]);
  });

  it('同一组段重复序列化结果稳定（缓存命中时也必须逐字节一致）', () => {
    const segments: MessageSegment[] = [{ kind: 'text', text: '重复序列化' }];

    expect(serializeSegments(segments)).toBe(serializeSegments(segments));
    expect(serializeSegments(segments)).toBe(JSON.stringify(segments));
  });
});
