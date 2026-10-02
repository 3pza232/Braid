import { describe, expect, it } from 'vitest';
import { createEmptyConversation } from '@domain/entities/conversation';
import { conversationToMarkdown } from '@domain/rules/conversationMarkdown';
import { asConversationId, asMessageId } from '@shared/ids';
import { node } from '../helpers/messageNode';

/**
 * 会话导出为 Markdown
 *
 * 导出是**给未来的自己看**的：它通常发生在"我要把这段对话存档/发给别人"的时候，
 * 所以两条性质最要紧 —— 内容不能缺（该看到的都在），也不能多
 * （旧分支与已删除的消息不该混进来，否则读起来前后矛盾）。
 */
const AT = 1_700_000_000_000;
const CONV = asConversationId('conv-1');

function conversation() {
  const created = createEmptyConversation(CONV, AT, { title: '第 1 次面谈' });
  // 激活路径从"虚拟根的直接子节点"开始：真实流程里加第一条消息时会写这个指针
  return { ...created, activeRootChildId: asMessageId('m1') };
}

/** 用户问 → 助手答（含思考与一次工具调用），串成一条激活路径 */
function linearPath() {
  const ask = node('m1', {
    conversationId: 'conv-1',
    role: 'user',
    segments: [{ kind: 'text', text: '帮我看下 notes.txt' }],
    activeChildId: asMessageId('m2'),
    createdAt: AT,
  });
  const answer = node('m2', {
    conversationId: 'conv-1',
    parentId: asMessageId('m1'),
    role: 'assistant',
    segments: [
      { kind: 'reasoning', text: '先读文件\n再总结' },
      { kind: 'tool_call', call: { id: asMessageId('t1') as never, name: 'read_file', argumentsJson: '{}' } },
      { kind: 'tool_result', callId: asMessageId('t1') as never, name: 'read_file', content: '内容', isError: false },
      { kind: 'text', text: '里面写的是三件事。' },
    ],
    createdAt: AT + 1000,
  });
  return [ask, answer];
}

describe('会话导出为 Markdown', () => {
  it('标题、元信息与正文都在，来源标记清楚', () => {
    const markdown = conversationToMarkdown({
      conversation: conversation(),
      nodes: linearPath(),
      exportedAt: AT + 5000,
    });

    expect(markdown).toContain('# 第 1 次面谈');
    expect(markdown).toContain('- 消息：2 条');
    expect(markdown).toContain('## 用户');
    expect(markdown).toContain('帮我看下 notes.txt');
    expect(markdown).toContain('## 助手');
    expect(markdown).toContain('里面写的是三件事。');
    // 结尾必须有换行（否则编辑器会把它当成一次未提交的改动）
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('思考过程与工具调用用引用块标出：读者能一眼分辨"这不是回答"', () => {
    const markdown = conversationToMarkdown({
      conversation: conversation(),
      nodes: linearPath(),
      exportedAt: AT,
    });

    expect(markdown).toContain('> 先读文件');
    expect(markdown).toContain('> 再总结');
    expect(markdown).toContain('> 调用工具 `read_file`');
    expect(markdown).toContain('> 工具 `read_file` 成功');
  });

  it('软删除的消息不进导出（导出的是"他现在看到的这段"）', () => {
    const [ask, answer] = linearPath();
    const deleted = { ...answer!, deletedAt: AT + 2000 };

    const markdown = conversationToMarkdown({
      conversation: conversation(),
      nodes: [ask!, deleted],
      exportedAt: AT,
    });

    expect(markdown).toContain('- 消息：1 条');
    expect(markdown).not.toContain('里面写的是三件事。');
  });

  it('旧分支不进导出：读者不该看到两套互相矛盾的对话', () => {
    const [ask, answer] = linearPath();
    // 一条被切走的旧分支：它挂在同一个 parent 下，但不在激活路径上
    const abandoned = node('m-old', {
      conversationId: 'conv-1',
      parentId: asMessageId('m1'),
      role: 'assistant',
      segments: [{ kind: 'text', text: '这是一条已经被切走的旧回答' }],
    });

    const markdown = conversationToMarkdown({
      conversation: conversation(),
      nodes: [ask!, answer!, abandoned],
      exportedAt: AT,
    });

    expect(markdown).not.toContain('已经被切走的旧回答');
    expect(markdown).toContain('里面写的是三件事。');
  });
});
