import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONVERSATION_TITLE,
  compareConversationsByRecency,
  createEmptyConversation,
  deriveTitleFromText,
} from '@domain/entities/conversation';
import { asConversationId } from '@shared/ids';

describe('createEmptyConversation', () => {
  it('默认是一条"什么都没覆盖"的普通对话', () => {
    const conversation = createEmptyConversation(asConversationId('c1'), 100);

    expect(conversation.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(conversation.writingMode).toBe('chat');
    // "未表态"字段必须是 null，而不是 false / 空串：
    // 它们承担"继承上一层"的语义，被填成默认值会让全局设置对所有历史会话失效
    expect(conversation.modelProfileId).toBeNull();
    expect(conversation.minOutputChars).toBeNull();
    expect(conversation.workspaceRoot).toBeNull();
    expect(conversation.deletedAt).toBeNull();
    expect(conversation.createdAt).toBe(100);
    expect(conversation.updatedAt).toBe(100);
  });

  it('init 里的字段覆盖默认值', () => {
    const conversation = createEmptyConversation(asConversationId('c1'), 100, {
      title: '我的小说',
      writingMode: 'long',
    });

    expect(conversation.title).toBe('我的小说');
    expect(conversation.writingMode).toBe('long');
  });
});

describe('deriveTitleFromText', () => {
  it('把连续空白压成一个空格并去掉首尾', () => {
    expect(deriveTitleFromText('你好    世界')).toBe('你好 世界');
    expect(deriveTitleFromText('\n  换行开头  \n')).toBe('换行开头');
  });

  it('空内容（含只有空白）回落成默认标题', () => {
    expect(deriveTitleFromText('')).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(deriveTitleFromText('   \n\t ')).toBe(DEFAULT_CONVERSATION_TITLE);
  });

  it('刚好到达上限时不加省略号', () => {
    const exact = 'a'.repeat(24);
    expect(deriveTitleFromText(exact)).toBe(exact);
    expect(deriveTitleFromText(exact)).not.toContain('…');
  });

  it('超长时截断并加省略号，长度是上限 + 1', () => {
    const long = '字'.repeat(30);
    const title = deriveTitleFromText(long);
    expect(title).toBe(`${'字'.repeat(24)}…`);
    expect(title).toHaveLength(25);
  });

  it('截断长度可调', () => {
    expect(deriveTitleFromText('一二三四五', 3)).toBe('一二三…');
  });
});

describe('compareConversationsByRecency', () => {
  it('越新越靠前（降序）', () => {
    const older = createEmptyConversation(asConversationId('a'), 100);
    const newer = createEmptyConversation(asConversationId('b'), 300);
    const middle = createEmptyConversation(asConversationId('c'), 200);

    const sorted = [older, newer, middle].sort(compareConversationsByRecency);
    expect(sorted.map((c) => c.id)).toEqual([asConversationId('b'), asConversationId('c'), asConversationId('a')]);
  });

  it('顺序定义只有这一份：存储层的 updated_at DESC 必须与它一致', () => {
    // 同样的时间戳时排序必须稳定（返回 0 而不是随机），否则列表会无端跳动
    const a = createEmptyConversation(asConversationId('a'), 100);
    const b = createEmptyConversation(asConversationId('b'), 100);
    expect(compareConversationsByRecency(a, b)).toBe(0);
  });
});

describe('DEFAULT_CONVERSATION_TITLE', () => {
  it('是 ChatService 判断"标题是否被改过"的依据，不能随手改字面量', () => {
    // ChatService.send() 用 `title === DEFAULT_CONVERSATION_TITLE` 决定要不要按首条提问自动起名，
    // 这里钉住它，避免有人改了常量却漏改散落各处的字面量（会把用户的命名覆盖掉）
    expect(DEFAULT_CONVERSATION_TITLE).toBe('新对话');
  });
});
