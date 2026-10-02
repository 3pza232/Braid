import { describe, expect, it } from 'vitest';
import { dropTargetFor, moveIdBy, moveIdTo, type RowRect } from '@ui/hooks/useDragReorder';

/**
 * 拖动排序的**算法**
 *
 * 这里才是真正会出错的地方：DOM 事件只是"什么时候调用它"，
 * 而"挪完之后顺序对不对"—— 尤其 `from < to`（移除元素会让后面的下标整体前移）
 * 和越界 —— 是纯计算，所以直接测它，不必去模拟拖拽事件。
 */
describe('moveIdTo', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('往后拖：占用目标项原来的位置（其后的项依次上移）', () => {
    expect(moveIdTo(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('往前拖：同样是占用目标项原来的位置', () => {
    expect(moveIdTo(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('拖到自己身上：原样返回', () => {
    expect(moveIdTo(ids, 'b', 'b')).toEqual(ids);
  });

  it('相邻互换', () => {
    expect(moveIdTo(ids, 'b', 'c')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('id 不在列表里（列表被改过）时原样返回，不制造半个顺序', () => {
    expect(moveIdTo(ids, 'ghost', 'b')).toEqual(ids);
    expect(moveIdTo(ids, 'a', 'ghost')).toEqual(ids);
  });

  it('不修改入参', () => {
    const source = [...ids];
    moveIdTo(source, 'a', 'd');
    expect(source).toEqual(ids);
  });
});

describe('moveIdBy', () => {
  const ids = ['a', 'b', 'c'];

  it('上移一位', () => {
    expect(moveIdBy(ids, 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('下移一位', () => {
    expect(moveIdBy(ids, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('到头了就不动（不是回绕到另一头）', () => {
    expect(moveIdBy(ids, 'a', -1)).toEqual(ids);
    expect(moveIdBy(ids, 'c', 1)).toEqual(ids);
  });

  it('id 不存在时原样返回', () => {
    expect(moveIdBy(ids, 'ghost', 1)).toEqual(ids);
  });
});

describe('dropTargetFor', () => {
  /** 三行，每行 20px，行间留 2px（真实列表就是这样，行之间有间隙） */
  const rows: RowRect[] = [
    { id: 'a', top: 0, bottom: 18 },
    { id: 'b', top: 20, bottom: 38 },
    { id: 'c', top: 40, bottom: 58 },
  ];

  it('指针在某一行里 → 就是这一行（沿用"占用目标项位置"的手感）', () => {
    expect(dropTargetFor(rows, 5)).toBe('a');
    expect(dropTargetFor(rows, 30)).toBe('b');
    expect(dropTargetFor(rows, 50)).toBe('c');
  });

  it('指针落在两行之间的缝隙里 → 归到最近的一行（等距时保持上方那一行）', () => {
    // 19 落在 a 与 b 之间那道 2px 的缝里：到两边的距离都是 1，先出现的 a 胜出
    expect(dropTargetFor(rows, 19)).toBe('a');
    // 21 也已经越过 b 的上边界，落在 b 里
    expect(dropTargetFor(rows, 21)).toBe('b');
  });

  it('指针在**最后一行下方的空白**里 → 落到最后一项（这就是"拖到最下面松手"）', () => {
    expect(dropTargetFor(rows, 59)).toBe('c');
    expect(dropTargetFor(rows, 400)).toBe('c');
  });

  it('指针在**第一行上方** → 落到第一项', () => {
    expect(dropTargetFor(rows, -50)).toBe('a');
  });

  it('列表为空时没有落点（不制造一个不存在的 id）', () => {
    expect(dropTargetFor([], 100)).toBeNull();
  });
});
