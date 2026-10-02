import { describe, expect, it } from 'vitest';
import { conversationFromRow } from '@adapters/storage/sqlite/conversationRows';
import { messageFromRow } from '@adapters/storage/sqlite/messageRows';
import {
  parseJson,
  roleFromRow,
  toBoolOrNull,
  toInt,
  toNumOrNull,
  toText,
} from '@adapters/storage/sqlite/rows';
import {
  CURRENT_CONVERSATION_SCHEMA_VERSION,
  DEFAULT_CONVERSATION_TITLE,
} from '@domain/entities/conversation';
import { CURRENT_MESSAGE_SCHEMA_VERSION } from '@domain/entities/message';
import { CURRENT_ROLE_SCHEMA_VERSION } from '@domain/entities/rolePreset';

/**
 * 存储读回的**容错**
 *
 * 库里的行不一定是这份代码写的：可能是旧版本留下的、可能被手工改过、
 * 也可能因为某次中断只写了一半。映射层的职责是把它们**收敛成合法实体**，
 * 而不是让 `undefined` 或一个形状不对的值一路冒到界面 —— 那种问题的表现是
 * 白屏或"某条消息点不开"，而且用户完全无从理解。
 *
 * 写半边（序列化）已经有用例（`messageRows.test.ts`），这里只钉读半边。
 */
describe('基础取值的容错', () => {
  it('parseJson：坏 JSON / 空串 / null 都回落，绝不抛', () => {
    expect(parseJson('{ 坏掉的', { a: 1 })).toEqual({ a: 1 });
    expect(parseJson('', [1])).toEqual([1]);
    expect(parseJson(null, 'fallback')).toBe('fallback');
    expect(parseJson(undefined, 'fallback')).toBe('fallback');
    expect(parseJson('null', 'fallback')).toBe('fallback');
  });

  it('toInt：非数字一律回落（NaN 不许污染业务）', () => {
    expect(toInt('12', 0)).toBe(12);
    expect(toInt('abc', 7)).toBe(7);
    expect(toInt(Number.NaN, 7)).toBe(7);
    expect(toInt(1.9, 0)).toBe(1); // 截断而不是四舍五入：时间戳不该被改写
  });

  it('toText：空串按"没有值"处理（与 null=继承 的语义对齐）', () => {
    expect(toText('  ')).toBe('  '); // 只有空白也算有值：那是用户真的输入了空格
    expect(toText('')).toBeNull();
    expect(toText(null)).toBeNull();
    expect(toText(42)).toBeNull();
  });

  it('toNumOrNull：保留 null（"继承全局"绝不能被压成 0）', () => {
    expect(toNumOrNull(null)).toBeNull();
    expect(toNumOrNull('0')).toBe(0);
    expect(toNumOrNull('abc')).toBeNull();
  });

  it('toBoolOrNull：三态都不塌陷', () => {
    expect(toBoolOrNull(null)).toBeNull();
    expect(toBoolOrNull(1)).toBe(true);
    expect(toBoolOrNull(0)).toBe(false);
    expect(toBoolOrNull('true')).toBe(true);
    expect(toBoolOrNull('false')).toBe(false);
    // 认不出来的值退回"继承"，而不是猜一个布尔
    expect(toBoolOrNull(7)).toBeNull();
  });
});

describe('messageFromRow', () => {
  it('空行也能读成一条合法消息（全部走默认值）', () => {
    const node = messageFromRow({});

    expect(node.role).toBe('assistant');
    expect(node.status).toBe('complete');
    expect(node.segments).toEqual([]);
    expect(node.schemaVersion).toBe(CURRENT_MESSAGE_SCHEMA_VERSION);
    expect(node.deletedAt).toBeNull();
  });

  it('认不出的枚举值：角色→assistant、状态→complete、结束原因→不带这个字段', () => {
    const node = messageFromRow({
      id: 'm1',
      role: 'robot',
      status: 'exploded',
      finish_reason: '因为心情不好',
    });

    expect(node.role).toBe('assistant');
    expect(node.status).toBe('complete');
    expect(node.finishReason).toBeUndefined();
  });

  it('段落：不是数组 → 空；认不出的 kind 被丢掉（留一个进去会让整条消息渲染失败）', () => {
    expect(messageFromRow({ segments_json: '42' }).segments).toEqual([]);
    expect(messageFromRow({ segments_json: '{"not":"array"}' }).segments).toEqual([]);

    const node = messageFromRow({
      segments_json: JSON.stringify([
        { kind: 'text', text: '正文' },
        { kind: '未来的新段落类型', payload: 1 },
        { kind: 'tool_call', call: { id: 'c1', name: 'x', argumentsJson: '{}' } },
      ]),
    });

    expect(node.segments.map((segment) => segment.kind)).toEqual(['text', 'tool_call']);
  });

  it('variantOf 缺失时退回自身（它是变体分组的锚，不能是空）', () => {
    expect(messageFromRow({ id: 'm9' }).variantOf).toBe('m9');
  });

  it('坏掉的 usage / params 快照：宁可没有，也不要一个形状不对的对象', () => {
    const node = messageFromRow({ usage_json: '{坏', params_snapshot_json: 'oops' });

    expect(node.usage).toBeUndefined();
    expect(node.paramsSnapshot).toBeUndefined();
  });
});

describe('conversationFromRow', () => {
  it('空行也能读成合法会话（标题回落默认值，档位回落普通对话）', () => {
    const conversation = conversationFromRow({});

    expect(conversation.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(conversation.writingMode).toBe('chat');
    expect(conversation.schemaVersion).toBe(CURRENT_CONVERSATION_SCHEMA_VERSION);
    expect(conversation.sortOrder).toBeNull();
  });

  it('认不出的 writing_mode → 普通对话（不认识的值不许冒到领域层）', () => {
    expect(conversationFromRow({ writing_mode: 'epic' }).writingMode).toBe('chat');
    expect(conversationFromRow({ writing_mode: 123 }).writingMode).toBe('chat');
    expect(conversationFromRow({ writing_mode: 'long' }).writingMode).toBe('long');
  });

  it('坏的 role_instance / forked_from：读成"没有"，而不是半个对象', () => {
    expect(conversationFromRow({ role_instance_json: '[]' }).roleInstance).toBeNull();
    expect(conversationFromRow({ forked_from_json: '{"conversationId":"c"}' }).forkedFrom).toBeNull();
    expect(
      conversationFromRow({ forked_from_json: '{"conversationId":"c","messageId":"m"}' }).forkedFrom,
    ).toEqual({ conversationId: 'c', messageId: 'm' });
  });

  it('allow_workspace_edit 的三态：null 必须留下（它是"继承全局"的载体）', () => {
    expect(conversationFromRow({ allow_workspace_edit: null }).allowWorkspaceEdit).toBeNull();
    expect(conversationFromRow({ allow_workspace_edit: 1 }).allowWorkspaceEdit).toBe(true);
    expect(conversationFromRow({ allow_workspace_edit: 0 }).allowWorkspaceEdit).toBe(false);
  });

  it('坏掉的 params_json：读成空参数，而不是一个数字（那会让下游到处读到 undefined）', () => {
    expect(conversationFromRow({ params_json: '42' }).params).toEqual({});
  });
});

describe('roleFromRow', () => {
  it('空行也能读成合法角色', () => {
    const role = roleFromRow({});

    expect(role.builtin).toBe(false);
    expect(role.tags).toEqual([]);
    expect(role.variables).toEqual({});
    expect(role.schemaVersion).toBe(CURRENT_ROLE_SCHEMA_VERSION);
  });

  it('tags_json 不是数组时读成空数组（否则整次装载会在这里抛掉）', () => {
    expect(roleFromRow({ tags_json: '42' }).tags).toEqual([]);
    expect(roleFromRow({ tags_json: '"单个字符串"' }).tags).toEqual([]);
    expect(roleFromRow({ tags_json: '["写作","技术",7]' }).tags).toEqual(['写作', '技术']);
  });

  it('variables_json 不是对象时读成空对象', () => {
    expect(roleFromRow({ variables_json: '42' }).variables).toEqual({});
    expect(roleFromRow({ variables_json: '"x"' }).variables).toEqual({});
    expect(roleFromRow({ variables_json: '{"a":"b"}' }).variables).toEqual({ a: 'b' });
  });

  it('坏掉的 avatar_json：退回默认头像而不是让头像渲染炸掉', () => {
    const role = roleFromRow({ avatar_json: '不是 JSON' });
    expect(role.avatar).toBeTruthy();
    expect(typeof role.avatar.color).toBe('string');
  });
});
