import { describe, expect, it } from 'vitest';
import {
  activePathIdsOf,
  activePathOf,
  buildTreeIndex,
  childrenOf,
  shiftVariant,
  variantPosition,
  variantsOf,
  type MessageLink,
} from '@domain/rules/messageTree';
import { asId, node } from '../helpers/messageNode';

/**
 * 结构版激活路径（跨会话搜索用）
 *
 * 它和 `activePathOf` 是同一件事的两份实现：一个要整棵树（含正文），
 * 一个只要三列指针。**两份实现就有漂移风险**，所以这里最要紧的不是
 * 各测各的，而是让它们在**同一份数据上必须给出同一条路径**。
 */
describe('activePathIdsOf', () => {
  const linksOf = (nodes: ReturnType<typeof node>[]): MessageLink[] =>
    nodes.map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      parentId: item.parentId,
      activeChildId: item.activeChildId,
    }));

  /** 一条主干 + 一个未选中的分支 + 根层两个变体 */
  const buildTree = () => [
    node('root', { activeChildId: asId('a2') }),
    node('root-alt'),
    node('a1', { parentId: asId('root') }),
    node('a2', { parentId: asId('root'), activeChildId: asId('b') }),
    node('b', { parentId: asId('a2') }),
  ];

  it('与 activePathOf 在同一条路径上（对照测试，防两套逻辑漂移）', () => {
    const nodes = buildTree();
    const viaNodes = activePathOf(buildTreeIndex(nodes), asId('root')).map((item) => item.id);

    expect(activePathIdsOf(linksOf(nodes), asId('root'))).toEqual(viaNodes);
  });

  it('只走被选中的那一支，未选中的分支不在路径上', () => {
    expect(activePathIdsOf(linksOf(buildTree()), asId('root'))).toEqual(['root', 'a2', 'b']);
  });

  it('根指针为空时路径为空', () => {
    expect(activePathIdsOf(linksOf(buildTree()), null)).toEqual([]);
  });

  it('指针指向不存在的节点时停下（数据损坏不该让搜索崩掉）', () => {
    const links: MessageLink[] = [
      { id: asId('a'), conversationId: 'c1', parentId: null, activeChildId: asId('ghost') },
    ];

    expect(activePathIdsOf(links, asId('a'))).toEqual(['a']);
  });

  it('环形引用时停下，不会死循环', () => {
    const links: MessageLink[] = [
      { id: asId('a'), conversationId: 'c1', parentId: null, activeChildId: asId('b') },
      { id: asId('b'), conversationId: 'c1', parentId: asId('a'), activeChildId: asId('a') },
    ];

    expect(activePathIdsOf(links, asId('a'))).toEqual(['a', 'b']);
  });
});

/**
 * 消息树查询规则
 *
 * 这些函数决定"用户看到哪条辫子""这条消息是第几个变体"，
 * 是「编辑即分支」（ADR-006）的查询半边。它们一旦出错，
 * 表现是"消息莫名其妙不见了"或"变体切换顺序乱跳"，很难倒查，所以逐条钉住。
 */
describe('buildTreeIndex', () => {
  it('按父节点归组，虚拟根用 null 作 key', () => {
    const a = node('a');
    const b = node('b', { parentId: asId('a') });
    const index = buildTreeIndex([a, b]);

    expect(index.byId.get(asId('a'))).toBe(a);
    expect(childrenOf(index, null)).toEqual([a]);
    expect(childrenOf(index, asId('a'))).toEqual([b]);
    // 没有任何子节点时返回空数组，而不是 undefined —— 调用方少一层判空
    expect(childrenOf(index, asId('b'))).toEqual([]);
  });

  it('同层子节点按「变体序号 → 创建时间」稳定排序', () => {
    /*
     * 顺序必须与插入顺序无关：数据从 SQLite 读回来时行序不保证稳定，
     * 若按读入顺序排，`‹ 2/3 ›` 会在每次刷新后跳位。
     */
    const late = node('late', { variantIndex: 1, createdAt: 100 });
    const first = node('first', { variantIndex: 0, createdAt: 200 });
    const tie = node('tie', { variantIndex: 1, createdAt: 50 });

    const index = buildTreeIndex([late, first, tie]);

    expect(childrenOf(index, null).map((n) => n.id)).toEqual(
      [first.id, tie.id, late.id], // variantIndex 0 → 1(variantIndex 1 里 createdAt 小的在前)
    );
  });

  it('默认隐藏已删除节点，显式要求时才给出', () => {
    const alive = node('alive');
    const gone = node('gone', { deletedAt: 123 });
    const index = buildTreeIndex([alive, gone]);

    expect(childrenOf(index, null).map((n) => n.id)).toEqual([alive.id]);
    expect(childrenOf(index, null, { includeDeleted: true })).toHaveLength(2);
  });
});

describe('activePathOf', () => {
  it('从虚拟根逐级跟随 activeChildId', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), activeChildId: asId('c') });
    const c = node('c', { parentId: asId('b') });
    const index = buildTreeIndex([a, b, c]);

    expect(activePathOf(index, asId('a')).map((n) => n.id)).toEqual([asId('a'), asId('b'), asId('c')]);
  });

  it('根指针为空时路径为空', () => {
    expect(activePathOf(buildTreeIndex([node('a')]), null)).toEqual([]);
  });

  it('遇到已删除节点就停，且不把它算进路径', () => {
    // 这是"删掉中间一条消息"后的正常状态：路径必须在它之前断掉，
    // 否则界面会渲染一条已被删除的消息
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), deletedAt: 1, activeChildId: asId('c') });
    const c = node('c', { parentId: asId('b') });
    const index = buildTreeIndex([a, b, c]);

    expect(activePathOf(index, asId('a')).map((n) => n.id)).toEqual([asId('a')]);
  });

  it('环形引用不会死循环（数据损坏时仍能渲染）', () => {
    const a = node('a', { activeChildId: asId('b') });
    const b = node('b', { parentId: asId('a'), activeChildId: asId('a') });

    expect(activePathOf(buildTreeIndex([a, b]), asId('a')).map((n) => n.id)).toEqual([
      asId('a'),
      asId('b'),
    ]);
  });

  it('指向不存在的节点时安全停下', () => {
    const a = node('a', { activeChildId: asId('ghost') });
    expect(activePathOf(buildTreeIndex([a]), asId('a')).map((n) => n.id)).toEqual([asId('a')]);
  });
});

describe('变体组', () => {
  const build = () => {
    // 同一父节点（虚拟根）下的三个变体：组号为 'v'
    const v1 = node('v1', { variantOf: asId('v1'), variantIndex: 0 });
    const v2 = node('v2', { variantOf: asId('v1'), variantIndex: 1 });
    const v3 = node('v3', { variantOf: asId('v1'), variantIndex: 2 });
    // 另一个逻辑消息的变体，不能混进来
    const other = node('o1', { variantOf: asId('o1'), variantIndex: 3 });
    return { v1, v2, v3, other, index: buildTreeIndex([v1, v2, v3, other]) };
  };

  it('变体按 variantOf 归组，不混入同层的其它逻辑消息', () => {
    const { v1, v2, v3, index } = build();
    expect(variantsOf(index, v2).map((n) => n.id)).toEqual([v1.id, v2.id, v3.id]);
  });

  it('已删除的变体不出现在组里（切换时不该切到一条看不见的消息）', () => {
    const { v1, index } = build();
    const withGone = buildTreeIndex([...index.byId.values()].map((n) =>
      n.id === asId('v2') ? { ...n, deletedAt: 9 } : n,
    ));
    expect(variantsOf(withGone, v1).map((n) => n.id)).toEqual([asId('v1'), asId('v3')]);
  });

  it('位置序号从 0 开始，总数等于可见变体数', () => {
    const { v1, v2, v3, index } = build();
    expect(variantPosition(index, v1)).toEqual({ position: 0, total: 3 });
    expect(variantPosition(index, v2)).toEqual({ position: 1, total: 3 });
    expect(variantPosition(index, v3)).toEqual({ position: 2, total: 3 });
  });

  it('自己不在组里时位置回落到 0，绝不返回 -1', () => {
    // 界面直接拿 position 显示，出现 -1 会渲染成「‹ 0/3 ›」
    const { index } = build();
    const orphan = node('orphan', { variantOf: asId('nobody') });
    expect(variantPosition(index, orphan)).toEqual({ position: 0, total: 0 });
  });

  it('切换变体首尾相连，不越界', () => {
    const { v1, v2, v3, index } = build();
    expect(shiftVariant(index, v1, 1)).toBe(v2);
    expect(shiftVariant(index, v1, -1)).toBe(v3); // 从第一个往前 = 绕到最后一个
    expect(shiftVariant(index, v3, 1)).toBe(v1); // 最后一个往后 = 绕回第一个
    expect(shiftVariant(index, v2, 2)).toBe(v1); // 一次跨两步
  });

  it('只有一个变体时不给切换（返回 null，按钮据此禁用）', () => {
    const { other, index } = build();
    expect(shiftVariant(index, other, 1)).toBeNull();
  });
});
