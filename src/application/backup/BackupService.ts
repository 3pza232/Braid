import { nanoid } from 'nanoid';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  parseBackupDocument,
  remapBackup,
  type BackupDocument,
} from '@domain/rules/backupDocument';
import type { BackupApi, BackupSummary } from '@ports/BackupApi';
import type { ConversationStore } from '@ports/repositories/ConversationStore';
import type { MessageStore } from '@ports/repositories/MessageStore';
import type { RoleApi } from '@ports/RoleApi';
import { appError, err, ok, type AppError, type Result } from '@shared/result';

/**
 * 全量备份服务
 *
 * 刻意**直接操作仓储**而不是走 ChatService / RoleService：
 * 备份是"把库里的一切原样搬走"，而那两个服务持有的是**当前会话的视图**
 * （消息树是按会话懒加载的）。走它们要么漏数据，要么得先把所有会话
 * 都加载进内存 —— 都不是备份该有的行为。
 */
export function createBackupService(deps: {
  conversations: ConversationStore;
  messages: MessageStore;
  roles: RoleApi;
}): BackupApi {
  return {
    async exportAll(): Promise<Result<string>> {
      const [conversations, messages] = await Promise.all([
        deps.conversations.list(),
        deps.messages.listAll(),
      ]);
      if (!conversations.ok) return conversations;
      if (!messages.ok) return messages;

      const document: BackupDocument = {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        exportedAt: Date.now(),
        conversations: conversations.data,
        messages: messages.data,
        roles: deps.roles.list(),
      };

      /*
       * 缩进 2 空格
       *
       * 多花的这点体积很值：备份文件是**人也会打开看**的（确认导的是哪一份、
       * 或者只想手工捞一条对话出来）。压成一行就完全没有这种可能了。
       */
      return ok(JSON.stringify(document, null, 2));
    },

    async importAll(json: string): Promise<Result<BackupSummary>> {
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        return err(appError('VALIDATION_ERROR', '这个文件不是合法的 JSON'));
      }

      const parsed = parseBackupDocument(raw);
      if (!parsed.ok) return err(appError('VALIDATION_ERROR', parsed.reason));

      // 全部重新发号：导入永远是"追加"，不会覆盖库里已有的任何东西
      const remapped = remapBackup(
        parsed.data.document,
        (prefix) => `${prefix}-${nanoid(10)}`,
        Date.now(),
      );

      // 角色先写：会话里的 roleId 指向它们
      let rolesWritten = 0;
      for (const role of remapped.document.roles) {
        const saved = await deps.roles.upsert(role);
        if (!saved.ok) return err(partialFailure(saved.error, rolesWritten, 0));
        rolesWritten += 1;
      }

      let conversationsWritten = 0;
      for (const conversation of remapped.document.conversations) {
        const saved = await deps.conversations.save(conversation);
        if (!saved.ok) {
          return err(partialFailure(saved.error, rolesWritten, conversationsWritten));
        }
        conversationsWritten += 1;
      }

      // 消息一次性批量写：一条一条写会让几千条消息的导入变成几分钟
      const written = await deps.messages.saveMany(remapped.document.messages);
      if (!written.ok) {
        return err(partialFailure(written.error, rolesWritten, conversationsWritten));
      }

      return ok({
        conversationCount: remapped.conversationCount,
        messageCount: remapped.messageCount,
        roleCount: remapped.roleCount,
        skipped: parsed.data.skipped,
        droppedMessages: remapped.droppedMessages,
      });
    },
  };
}

/**
 * 导入中途失败时，把**已经写进去的部分**说清楚
 *
 * 【为什么不做成"要么全成功、要么全失败"】
 * 导入跨了三个仓储（角色 / 会话 / 消息），而底层的原子性原语
 * （`SqlPort.batch`）只能覆盖单个仓储的语句 —— 跨仓储事务需要扩协议，
 * 代价远大于这里的问题本身（残留的都是**自洽**的数据：角色、会话、消息各自完整，
 * 只是这份备份只进去了一半）。
 *
 * 所以采取"如实报告"：说清已写入多少，并提醒再导一次会重复。
 * 早先这里直接返回原始错误，用户会以为"导入失败 = 什么都没变"，
 * 于是重新导一次 —— 库里就出现两份。
 */
function partialFailure(error: AppError, roles: number, conversations: number): AppError {
  return {
    ...error,
    message:
      `导入中途失败（已写入 ${roles} 个角色、${conversations} 个会话；` +
      `再次导入这些会重复）：${error.message}`,
  };
}
