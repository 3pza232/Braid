import type { Result } from '@shared/result';

/**
 * 一次性文件对话框
 *
 * 与 `FileSystemPort`（工作区目录句柄）的区别：
 *  - 那个管"一个**持久**的目录授权"，选一次、用很久；
 *  - 这个管"保存/打开**一个**文件"这种一次性动作，选完就结束。
 * 把两件事混在一个端口里，会让"打开一个 json"也去申请目录权限。
 *
 * 放在宿主端口层，是因为"怎么弹文件对话框"完全取决于平台：
 * 目前一律走 File System Access（桌面壳本可给原生对话框，但那需要 IPC 与
 * Node 能力，见 `electron/main.cjs` 的取舍）。
 */
export interface FileDialogPort {
  /**
   * 让用户挑个位置保存文本文件
   *
   * 返回 `false` 表示**用户取消** —— 取消不是错误，调用方不该弹"保存失败"。
   * 这个区分很实际：把取消当失败，用户每次反悔都会看到一条红字。
   */
  saveText(suggestedName: string, text: string): Promise<Result<boolean>>;

  /** 让用户挑一个文本文件读进来；`data` 为 `null` 表示用户取消 */
  openText(description: string, extensions: string[]): Promise<Result<string | null>>;

  /** 当前环境是否支持"真正的另存为"（否则退化成浏览器下载） */
  isSupported(): boolean;
}
