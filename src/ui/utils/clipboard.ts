/**
 * 复制文本到剪贴板
 *
 * 【为什么要有这个函数，而不是各处直接写 `navigator.clipboard?.writeText`】
 * 那句写法把两种情况都吞掉了，而且都表现为"按了没反应"：
 *  - `navigator.clipboard` 在**非安全上下文**（http 打开、某些 WebView 设置）下是 `undefined`，
 *    `?.` 直接短路 —— 什么都没发生，也没有任何解释；
 *  - 权限被拒 / 文档失去焦点时 `writeText` 会 **reject**，没人接就是一条未处理的 promise。
 *
 * 所以它返回是否成功，让调用方至少能在失败时说话（见 `COPY_FAILED_MESSAGE`）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 复制失败时给用户看的说明
 *
 * 成功不必打扰（粘一下就知道），失败必须说 —— 否则用户只会以为按钮坏了。
 */
export const COPY_FAILED_MESSAGE =
  '复制失败：浏览器没有把内容交给剪贴板（可能不是 HTTPS，或剪贴板权限被拒绝）';
