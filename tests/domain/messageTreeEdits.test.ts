import { describe, expect, it } from 'vitest';
import {
  activeChildOf,
  activeLeafIdOf,
  withActiveChild,
  withNodeAdded,
  withNodeRemoved,
  withNodeTextPatched,
  withSoftDelete,
  type TreeState,
} from '@domain/rules/messageTreeEdits';
import { activePathOf, buildTreeIndex, variantsOf } from '@domain/rules/messageTree';
import { asId, node, textOf, tree } from '../helpers/messageNode';

/**
 * 消息树编辑操作（ADR-006「编辑即分支」的写入半边）
 *
 * 三条不变量，每个用例都在验证其中之一：
 *  1. **不可变** —— 输入状态永不被修改（UI 靠引用比较决定要不要重渲染）；
 *  2. **不覆盖** —— 任何操作都不会抹掉已有节点的正文；
 *  3. **不留悬挂指针** —— 激活路径永远不指向已删除或不存在的节点。
 */
describe('withNodeAdded', () => {
  it('追加到末尾，并把父节点的选中指针指过去', () => {
    const a = node('a');
    const added = node('b', { parentId: asId('a') });
    const next = withNodeAdded(tree([a]), added);

    expect(next.nodes).toHaveLength(2);
    expect(next.nodes[1]).toBe(added);
    expect(activeChildOf(next, asId('a'))).toBe(asId('b'));
  });

  it('根层节点改的是虚拟根指针（首条消息没有父节点）', () => {
    const next = withNodeAdded(tree([]), node('a'));
    expect(next.activeRootChildId).toBe(asId('a'));
  });

  it('activate: false 只加节点、不动选中（生成分支时不抢走用户的视线）', () => {
    const next = withNodeAdded(tree([node('a')]), node('b'), { activate: false });
    expect(next.activeRootChildId).toBeNull();
    expect(next.nodes).toHaveLength(2);
  });

  it('不修改入参', () => {
    const before = tree([node('a')]);
    withNodeAdded(before, node('b'));
    expect(before.nodes).toHaveLength(1);
    expect(before.activeRootChildId).toBeNull();
  });
});

describe('withActiveChild', () => {
  it('把选中指针挪到指定的孩子', () => {
    const next = withActiveChild(tree([node('a'), node('b')]), null, asId('b'));
    expect(next.activeRootChildId).toBe(asId('b'));
  });

  it('拒绝把指针指向已删除的节点，并原样返回（引用不变）', () => {
    // 返回同一个对象而不是"改回原值的副本"：调用方用引用比较判断有没有变化
    const before = tree([node('a'), node('b', { deletedAt: 7 })]);
    expect(withActiveChild(before, null, asId('b'))).toBe(before);
  });

  it('拒绝指向不存在的节点（否则路径会断在半空）', () => {
    const before = tree([node('a')]);
    expect(withActiveChild(before, null, asId('ghost'))).toBe(before);
  });
});

describe('withNodeTextPatched', () => {
  it('就地改正文：这是唯一一条"不产生新版本"的编辑路径', () => {
    const before = tree([node('a'), node('b')]);
    const next = withNodeTextPatched(before, asId('b'), '改好了', 999);
    const patched = next.nodes[1];

    expect(textOf(patched)).toBe('改好了');
    expect(patched.updatedAt).toBe(999);
    // 只保存不该动树结构
    expect(next.activeRootChildId).toBe(before.activeRootChildId);
    expect(next.nodes).toHaveLength(2);
  });

  it('其它节点保持同一引用（避免整棵树重渲染）', () => {
    const before = tree([node('a'), node('b')]);
    const next = withNodeTextPatched(before, asId('b'), 'x', 1);
    expect(next.nodes[0]).toBe(before.nodes[0]);
  });

  it('保留工具调用与思考段，只换文本段', () => {
    // "改一句话"不该把工具调用的轨迹一并抹掉
    const target = node('a', {
      segments: [
        { kind: 'reasoning', text: '想过' },
        { kind: 'text', text: '旧正文' },
        { kind: 'tool_call', call: { id: asId('t1') as never, name: 'read_file', argumentsJson: '{}' } },
        { kind: 'tool_result', callId: asId('t1') as never, name: 'read_file', content: 'ok', isError: false },
      ],
    });
    const patched = withNodeTextPatched(tree([target]), asId('a'), '新正文', 1).nodes[0];

    expect(patched.segments.map((s) => s.kind)).toEqual([
      'reasoning',
      'text',
      'tool_call',
      'tool_result',
    ]);
    expect(textOf(patched)).toBe('新正文');
  });

  it('多个文本段合并成一段（不留下空的旧段）', () => {
    const target = node('a', {
      segments: [
        { kind: 'text', text: '第一段' },
        { kind: 'text', text: '第二段' },
      ],
    });
    const patched = withNodeTextPatched(tree([target]), asId('a'), '合并后', 1).nodes[0];

    expect(patched.segments).toEqual([{ kind: 'text', text: '合并后' }]);
  });

  it('原本没有文本段时补在末尾', () => {
    const target = node('a', { segments: [{ kind: 'reasoning', text: '只有思考' }] });
    const patched = withNodeTextPatched(tree([target]), asId('a'), '补上', 1).nodes[0];

    expect(patched.segments.map((s) => s.kind)).toEqual(['reasoning', 'text']);
  });

  it('找不到目标时原样返回', () => {
    const before = tree([node('a')]);
    expect(withNodeTextPatched(before, asId('ghost'), 'x', 1).nodes).toEqual(before.nodes);
  });
});

describe('withSoftDelete', () => {
  it('软删除本身连整棵子树一起标记，但不移除任何行', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), activeChildId: asId('c') });
    const c = node('c', { parentId: asId('b') });
    const next = withSoftDelete(tree([a, b, c]), asId('a'), 500);

    expect(next.nodes).toHaveLength(3); // 一条都没少
    expect(next.nodes.every((n) => n.deletedAt === 500)).toBe(true);
    // 路径随之清空
    expect(activePathOf(buildTreeIndex(next.nodes), next.activeRootChildId)).toEqual([]);
  });

  it('早先已删除的节点保留自己的删除时间（不被覆盖）', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), deletedAt: 111 });
    const next = withSoftDelete(tree([a, b]), asId('a'), 999);

    expect(next.nodes[1].deletedAt).toBe(111);
  });

  it('删掉当前选中分支时，指针回退到同组仍然可见的兄弟', () => {
    const v1 = node('v1', { activeChildId: asId('child1') });
    const child1 = node('child1', { parentId: asId('v1') });
    const v2 = node('v2', { variantOf: asId('v1'), variantIndex: 1 });
    // v1 被删，v2 还看得见 → 指针应落到 v2
    const next = withSoftDelete(tree([v1, child1, v2], 'v1'), asId('v1'), 3);

    expect(next.activeRootChildId).toBe(asId('v2'));
    expect(activePathOf(buildTreeIndex(next.nodes), next.activeRootChildId).map((n) => n.id)).toEqual([
      asId('v2'),
    ]);
  });

  it('兄弟也都不可见时指针置空，绝不指向一条看不见的消息', () => {
    const v1 = node('v1', { variantOf: asId('v1') });
    const v2 = node('v2', { variantOf: asId('v1'), variantIndex: 1, deletedAt: 1 });
    const next = withSoftDelete(tree([v1, v2], 'v1'), asId('v1'), 3);

    expect(next.activeRootChildId).toBeNull();
  });

  it('删除的不是当前选中分支时，指针不动', () => {
    const v1 = node('v1', { variantOf: asId('v1') });
    const v2 = node('v2', { variantOf: asId('v1'), variantIndex: 1 });
    const next = withSoftDelete(tree([v1, v2], 'v2'), asId('v1'), 3);

    expect(next.activeRootChildId).toBe(asId('v2'));
  });

  it('不存在的 id 原样返回', () => {
    const before = tree([node('a')]);
    expect(withSoftDelete(before, asId('ghost'), 1)).toBe(before);
  });
});

describe('withNodeRemoved（只删一条，不连带后续）', () => {
  /** a → b → c 一条直线的会话 */
  const chain = (): TreeState =>
    tree(
      [
        node('a', { activeChildId: asId('b') }),
        node('b', { parentId: asId('a'), activeChildId: asId('c') }),
        node('c', { parentId: asId('b') }),
      ],
      'a',
    );

  it('删中间一条：只有它被软删，后面的消息接到前面那条上（仍然看得见）', () => {
    const next = withNodeRemoved(chain(), asId('b'), 42);

    expect(next.nodes.find((n) => n.id === asId('b'))?.deletedAt).toBe(42);

    // 后面的消息没被删，而且父亲换成了 a
    const c = next.nodes.find((n) => n.id === asId('c'));
    expect(c?.deletedAt).toBeNull();
    expect(c?.parentId).toBe(asId('a'));

    // 用户实际看到的路径：a → c（少了一环，后面的还在）
    expect(
      activePathOf(buildTreeIndex(next.nodes), next.activeRootChildId).map((n) => n.id),
    ).toEqual([asId('a'), asId('c')]);
  });

  it('父节点的指针改指接过来的第一个孩子（当前这条线不会断在半空）', () => {
    const next = withNodeRemoved(chain(), asId('b'), 42);
    expect(activeChildOf(next, asId('a'))).toBe(asId('c'));
  });

  it('删最后一条：前面不受影响，指针置空（下次发言仍接在它后面）', () => {
    const next = withNodeRemoved(chain(), asId('c'), 42);

    expect(activeChildOf(next, asId('b'))).toBeNull();
    expect(activeLeafIdOf(next)).toBe(asId('b'));
  });

  it('接过来的孩子仍只和自己的变体组互为一组（不和父节点原有兄弟混组）', () => {
    // p 下面有两个变体 v1 / v2；v1 自己带着孩子 c1
    const p = node('p', { activeChildId: asId('v1') });
    const v1 = node('v1', { parentId: asId('p'), activeChildId: asId('c1') });
    const v2 = node('v2', { parentId: asId('p'), variantOf: asId('v1'), variantIndex: 1 });
    const c1 = node('c1', { parentId: asId('v1') });

    const next = withNodeRemoved(tree([p, v1, v2, c1], 'p'), asId('v1'), 9);
    const index = buildTreeIndex(next.nodes);
    const find = (raw: string) => next.nodes.find((item) => item.id === asId(raw))!;

    // c1 现在挂在 p 下面，但它和 v2 不是一组
    expect(variantsOf(index, find('c1')).map((item) => item.id)).toEqual([asId('c1')]);
    // v2 自成一组（它原本的那组只剩它自己）
    expect(variantsOf(index, find('v2')).map((item) => item.id)).toEqual([asId('v2')]);
  });

  it('已经删过的再删一次：原样返回（不覆盖原来的删除时间）', () => {
    const before = tree([node('a', { deletedAt: 5 })]);
    expect(withNodeRemoved(before, asId('a'), 9)).toBe(before);
  });

  it('不修改入参（UI 靠引用比较决定要不要重渲染）', () => {
    const before = chain();
    const c = before.nodes[2];

    withNodeRemoved(before, asId('b'), 42);

    expect(before.nodes[2]).toBe(c);
    expect(c?.parentId).toBe(asId('b'));
  });
});

describe('activeLeafIdOf', () => {
  it('返回激活路径末端 —— 新消息就追加在它下面', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a') });
    expect(activeLeafIdOf(tree([a, b], 'a'))).toBe(asId('b'));
  });

  it('空树返回 null', () => {
    expect(activeLeafIdOf(tree([]))).toBeNull();
  });

  it('路径上出现已删除节点时停在它之前', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), deletedAt: 1, activeChildId: asId('c') });
    const c = node('c', { parentId: asId('b') });
    expect(activeLeafIdOf(tree([a, b, c], 'a'))).toBe(asId('a'));
  });

  it('环形引用不会死循环', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), activeChildId: asId('a') });
    expect(activeLeafIdOf(tree([a, b], 'a'))).toBe(asId('b'));
  });
});
