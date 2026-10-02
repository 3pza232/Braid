/**
 * 导入汇总的**跨重载**交接
 *
 * 【为什么需要它】
 * 备份导入完之后界面会整页重载（见 `Sidebar.handleImportBackup` 的说明：与其在十几个
 * 地方做失效通知，不如重载一次）。但重载会**立刻冲掉刚推的通知条** ——
 * 于是"导入了多少、跳过了多少、丢了什么"这些话，用户永远看不到，
 * 而这恰恰是他最需要知道的一次性信息（数据有没有少，只能从这句话里看出来）。
 *
 * 所以先寄存在 `sessionStorage`（只活在这个标签页，刷新后由启动流程取走并清掉），
 * 刷新后由 `main.tsx` 重新推成通知条。用 sessionStorage 而不是 localStorage：
 * 这是"这一次交接"，不该在下次打开应用时又冒出来。
 */

const KEY = 'braid.importSummary';

/** 存下这句话；存储不可用（隐私模式等）时静默失败 —— 别为一个提示再抛一次错 */
export function stashImportSummary(message: string): void {
  try {
    window.sessionStorage.setItem(KEY, message);
  } catch {
    // 存不下就算了：调用方会退回"重载前先推一条通知"，至少有一瞬间能看见
  }
}

/** 取走这句话（取完即清，保证只显示一次）；没有则返回 null */
export function takeImportSummary(): string | null {
  try {
    const message = window.sessionStorage.getItem(KEY);
    if (message !== null) window.sessionStorage.removeItem(KEY);
    return message;
  } catch {
    return null;
  }
}
