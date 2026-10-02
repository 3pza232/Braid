/**
 * 会话搜索的近似匹配（纯规则）
 *
 * 【为什么不用现成的模糊搜索库】
 * 会话标题一般就几个字，且以中文为主。常见的模糊搜索库（fuse.js 之类）
 * 是为"在几千条英文记录里找相近词"设计的，带评分与排序，
 * 依赖几十 KB、还得调阈值 —— 对十几条标题来说是大炮打蚊子。
 *
 * 这里的规则刻意简单，两步命中：
 *  1. **连续子串**：`修钟` 命中 `修钟人`（最常见，也最快）；
 *  2. **按顺序的子序列**：`钟人` 也能命中 `修钟人`（少打两个字也能找到），
 *     但 `人钟` 命中不了 —— 顺序乱了通常说明用户想找的是别的东西，
 *     这时候"宁可不命中"比"命中一堆不相关的"更好用。
 *
 * 空格与大小写不参与比较：`AI 写作` 和 `ai写作` 应该是同一个查询。
 */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = normalize(text);
  const needle = normalize(query);
  // 空查询 = 不过滤
  if (needle.length === 0) return true;
  if (haystack.includes(needle)) return true;

  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

/** 归一化：去掉所有空白、转小写。中英混排的标题也能对上 */
function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}
