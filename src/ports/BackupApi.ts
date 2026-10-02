import type { Result } from '@shared/result';

/** 一次导入的结果 —— 界面上要说清"到底进来了多少"，不能只说"成功" */
export interface BackupSummary {
  conversationCount: number;
  messageCount: number;
  roleCount: number;
  /** 因结构不完整被跳过的条目数 */
  skipped: number;
  /** 因所属会话不在备份里而被丢弃的消息数 */
  droppedMessages: number;
}

/**
 * 全量备份
 *
 * 这是"本地优先"最后的保险：数据只在这一台机器、这一个浏览器源上，
 * 所以必须有一条把全部内容搬走、再搬回来的路。
 * 不含设置（里面有明文 Key），理由见 domain/rules/backupDocument.ts。
 */
export interface BackupApi {
  /** 导出为 JSON 文本 */
  exportAll(): Promise<Result<string>>;
  /** 从 JSON 文本导入（**追加**，不会覆盖已有数据） */
  importAll(json: string): Promise<Result<BackupSummary>>;
}
