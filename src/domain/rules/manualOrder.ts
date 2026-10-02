import { compareConversationsByRecency, type Conversation } from '@domain/entities/conversation';
import type { RolePreset } from '@domain/entities/rolePreset';

/**
 * 手动排序
 *
 * 【为什么顺序存在行上，而不是"一个顺序数组"】
 * 顺序是这一行的属性：跟着行走，导入/导出/备份都自动带上，
 * 也不可能出现"数据在表里、顺序在别处"的两份真相。
 *
 * 【语义：手动序优先】
 * 拖过一次之后，顺序由用户决定 —— 新消息**不会**再把它顶到最上面。
 * 这是刻意的：这类功能最常见的挫败就是"我刚排好，发了一条消息它又跳回去了"。
 * 没被手动排过的（`sortOrder === null`）排在排过的之后，内部按各自的默认规则。
 */

export interface Orderable {
  readonly id: string;
  readonly sortOrder: number | null;
}

/**
 * 比较两项：手动序优先，未排过的用 `fallback` 决出先后
 *
 * 两边都排过时比 `sortOrder`；只排过一边的排前面；都没排过则交给 `fallback`。
 * 相等时以 fallback 兜底，保证排序**稳定**（不会因为两次排序给出不同顺序）。
 */
export function compareManualOrder<T extends Orderable>(
  a: T,
  b: T,
  fallback: (left: T, right: T) => number,
): number {
  if (a.sortOrder !== null || b.sortOrder !== null) {
    const left = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const right = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
  }
  return fallback(a, b);
}

/**
 * 新建项该用的编号：**排在所有已手动排过的项之前**
 *
 * 【为什么需要它】
 * "新建的会话/角色出现在最前"这件事，只靠"往数组前面插一个"是保不住的：
 * 列表展示用的是手动序，而没编号的项（`sortOrder === null`）按规则排在**已排过的之后**，
 * 于是刷新一次，刚建的那个就掉到底下去了。
 *
 * 【为什么没有手动序时返回 `null`】
 * 那就该走默认规则（会话按最近使用、角色按"自建在前"）：新建的天然在最前，
 * 不必往数据里写一个凭空多出来的编号。少写一个值，也少一处将来会看不懂的来源。
 */
export function topOrderOf(items: readonly Orderable[]): number | null {
  const orders = items
    .map((item) => item.sortOrder)
    .filter((value): value is number => value !== null);
  if (orders.length === 0) return null;

  // 取比现有最小值再小一档：不需要重编号别人的行，也就不需要一次批量写
  return Math.min(...orders) - 1;
}

/**
 * 拖动之后重新编号：按 `orderedIds` 的顺序写 0..n-1
 *
 * 不在这份 id 里的项**保持原编号不动**（例如被搜索过滤掉、没显示出来的那些）：
 * 给看不见的东西重编号，等于用户每次拖动都在悄悄改动他没看到的东西。
 * 返回新的数组（不修改入参），只替换真的变了的项。
 *
 * 【已知边界：可能与"没参与排序的项"同号】
 * 例如在搜索结果里拖动一个子集：它拿到 0..n-1，而列表里那些被过滤掉的项
 * 可能本来就持有 0..n-1 中的某个值。同号时由 `fallback` 决出先后 ——
 * 顺序仍然是**确定**的（不会时好时坏），只是那两项之间的先后由默认规则决定。
 * 之所以不顺手给看不见的项重编号：那等于用户每拖一次，都在悄悄改动
 * 他没看到的东西的位置。
 */
export function renumberByOrder<T extends Orderable>(
  items: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const next = new Map<string, number>();
  orderedIds.forEach((id, index) => next.set(id, index));

  return items.map((item) => {
    const order = next.get(item.id);
    if (order === undefined || order === item.sortOrder) return item;
    return { ...item, sortOrder: order };
  });
}

/** 会话列表：手动序优先，其余按最近使用 */
export function orderConversations(list: readonly Conversation[]): Conversation[] {
  return [...list].sort((a, b) => compareManualOrder(a, b, compareConversationsByRecency));
}

/**
 * 角色列表：手动序优先
 *
 * 默认规则沿用原来的"用户自己搓的排前面、同组按更新时间倒序"——
 * 它原本是 `RoleService` 里的私有函数，搬到领域层是为了能被单测，
 * 也为了与"手动序"这套规则放在一起（它们本来就是在回答同一个问题）。
 */
export function orderRoles(list: readonly RolePreset[]): RolePreset[] {
  return [...list].sort((a, b) => compareManualOrder(a, b, compareRolesByDefault));
}

function compareRolesByDefault(a: RolePreset, b: RolePreset): number {
  if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}
