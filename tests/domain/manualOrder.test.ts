import { describe, expect, it } from 'vitest';
import { createEmptyConversation } from '@domain/entities/conversation';
import type { Conversation } from '@domain/entities/conversation';
import {
  compareManualOrder,
  orderConversations,
  renumberByOrder,
  topOrderOf,
} from '@domain/rules/manualOrder';
import { asConversationId } from '@shared/ids';

/**
 * 手动排序的规则
 *
 * 它是"拖动顺序"这件事的**唯一一份定义**：存储、应用层、搜索结果的先后都引用它。
 * 所以这里把三条性质钉住 —— 手动序优先、未排过的按默认规则、以及排序**稳定**
 * （随便排两次不能给出不同顺序，否则界面会无缘无故抖）。
 */

const NOW = 1_700_000_000_000;

function conversation(title: string, sortOrder: number | null, updatedAt = NOW): Conversation {
  return {
    ...createEmptyConversation(asConversationId(`conv-${title}`), NOW, { title }),
    sortOrder,
    updatedAt,
  };
}

describe('compareManualOrder', () => {
  it('两边都排过：比编号', () => {
    expect(compareManualOrder(conversation('a', 1), conversation('b', 2), () => 0)).toBeLessThan(0);
  });

  it('只排过一边：排过的在前（无论编号多大）', () => {
    expect(
      compareManualOrder(conversation('a', 99), conversation('b', null), () => 1),
    ).toBeLessThan(0);
  });

  it('都没排过：交给默认规则', () => {
    const fallback = () => 42;
    expect(compareManualOrder(conversation('a', null), conversation('b', null), fallback)).toBe(42);
  });

  it('编号相同时用默认规则兜底：排序才是稳定的', () => {
    // 两行同号（例如旧数据）不能出现"两次排出来的顺序不一样"
    expect(compareManualOrder(conversation('a', 3), conversation('b', 3), () => 7)).toBe(7);
  });
});

describe('orderConversations', () => {
  it('手动序优先，未排过的按最近使用排在后面', () => {
    const list = [
      conversation('新但没排过', null, NOW + 5000),
      conversation('第三', 2, NOW),
      conversation('第一', 0, NOW),
      conversation('第二', 1, NOW),
    ];

    expect(orderConversations(list).map((item) => item.title)).toEqual([
      '第一',
      '第二',
      '第三',
      '新但没排过',
    ]);
  });

  it('不修改入参', () => {
    const list = [conversation('b', 1), conversation('a', 0)];

    orderConversations(list);

    expect(list.map((item) => item.title)).toEqual(['b', 'a']);
  });
});

describe('renumberByOrder', () => {
  it('按传入顺序写 0..n-1，未提到的项原样保留', () => {
    const list = [conversation('a', null), conversation('b', null), conversation('c', 5)];

    const next = renumberByOrder(list, ['conv-b', 'conv-a']);

    expect(next.find((item) => item.title === 'b')?.sortOrder).toBe(0);
    expect(next.find((item) => item.title === 'a')?.sortOrder).toBe(1);
    // c 没在列表里：不动它（给看不见的东西重编号等于悄悄改动用户没看到的东西）
    expect(next.find((item) => item.title === 'c')?.sortOrder).toBe(5);
  });

  it('编号没变的项保持**同一个对象**（调用方靠引用判断"要不要写库"）', () => {
    const list = [conversation('a', 0), conversation('b', 1)];

    const next = renumberByOrder(list, ['conv-a', 'conv-b']);

    expect(next[0]).toBe(list[0]);
    expect(next[1]).toBe(list[1]);
  });
});

describe('topOrderOf', () => {
  it('有手动序时给出比最小值更小的一档', () => {
    expect(topOrderOf([conversation('a', 0), conversation('b', 3)])).toBe(-1);
    expect(topOrderOf([conversation('a', 5)])).toBe(4);
  });

  it('全都没排过时返回 null：交给默认规则，不写凭空多出来的编号', () => {
    expect(topOrderOf([conversation('a', null), conversation('b', null)])).toBeNull();
    expect(topOrderOf([])).toBeNull();
  });
});
