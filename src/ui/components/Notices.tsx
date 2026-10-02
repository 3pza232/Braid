import { useState } from 'react';
import { useChatStore } from '@ui/stores/chatStore';
import { useStorageStore } from '@ui/stores/storageStore';
import { useUiStore } from '@ui/stores/uiStore';
import { useWorkspaceStore } from '@ui/stores/workspaceStore';
import { IconClose } from './Icons';
import styles from './Notices.module.css';

/**
 * 全局通知条
 *
 * 【为什么单独做一层，而不是把消息塞进各个面板】
 * 「AI 想改文件但没权限」这类事件**没有归属的组件** —— 它既不属于某条消息，
 * 也不属于设置面板（用户可能压根没打开它）。塞进任何一个面板都会变成
 * "只有碰巧打开那个面板的人才知道发生了什么"。
 *
 * 所以做成挂在应用根部的通知条：无论用户当时在看哪里，都能看到。
 *
 * 它现在聚合**两个错误通道**（工作区、聊天）。这两个 store 各自持有 error
 * 是历史形成的，统一到这里展示而不是各自在界面角落显示 ——
 * 分散显示的代价是真实的：曾有段时间聊天错误被写进了 store 却没有任何组件去读它。
 *
 * 【它和"告知模型"是两件事】
 * 模型收到的是工具失败返回的 `FS_EDIT_DENIED`（由工具循环转成一条失败的
 * `tool_result`）。这一层只管人。
 */
export function Notices() {
  const alerts = useWorkspaceStore((s) => s.alerts);
  const workspaceError = useWorkspaceStore((s) => s.error);
  const clearWorkspaceError = useWorkspaceStore((s) => s.clearError);
  const dismissAlert = useWorkspaceStore((s) => s.dismissAlert);
  const chatError = useChatStore((s) => s.error);
  const clearChatError = useChatStore((s) => s.clearError);
  /*
   * "内容没存下来"
   *
   * 与上面的命令错误分开显示：这条不表示操作失败，而表示**屏幕上的内容没有落库** ——
   * 用户如果不当场知道，就会在重开页面时莫名其妙地少掉一段长回答。
   */
  const persistenceError = useChatStore((s) => s.persistenceError);
  const [persistenceDismissed, setPersistenceDismissed] = useState(false);
  const showPersistenceError = persistenceError !== null && !persistenceDismissed;
  // 通用通知通道：任何"告诉用户一句话"的地方都走它（别再 window.alert）
  const notices = useUiStore((s) => s.notices);
  const dismissNotice = useUiStore((s) => s.dismissNotice);
  /*
   * 本地存储出问题（库读不出来、被重建、写入失败）
   *
   * 这条以前**只出现在「设置 → 关于」**里 —— 而装载失败的用户看到的是一个空白界面，
   * 他不会想到去设置页找原因，只会以为"本来就没有数据"。存储是地基，
   * 地基出问题必须在他眼前说清楚。
   */
  const storageError = useStorageStore((s) => s.status.error);
  /** 只在本页隐藏：它表达的是存储的当前状态，刷新后如果还没好就该再出现 */
  const [storageDismissed, setStorageDismissed] = useState(false);
  const showStorageError = storageError !== null && !storageDismissed;

  const hasContent =
    alerts.length > 0 ||
    workspaceError !== null ||
    chatError !== null ||
    showStorageError ||
    showPersistenceError ||
    notices.length > 0;
  if (!hasContent) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {/* 通用通知排在最上面：它通常是"刚发生的事"，比常驻的错误更该先被看到 */}
      {notices.map((notice) => (
        <div key={notice.id} className={styles.notice} data-tone={notice.tone}>
          <span className={styles.text}>{notice.message}</span>
          {/* 有动作（目前只有"撤销"）就先给动作，再给关闭 —— 想反悔的人一眼就能看到 */}
          {notice.action ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                notice.action?.run();
                dismissNotice(notice.id);
              }}
            >
              {notice.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.close}
            onClick={() => dismissNotice(notice.id)}
            aria-label="关闭"
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}

      {showPersistenceError ? (
        <div className={styles.notice} data-tone="error">
          <span className={styles.text}>{persistenceError}</span>
          <button
            type="button"
            className={styles.close}
            onClick={() => setPersistenceDismissed(true)}
            aria-label="关闭"
          >
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      {showStorageError ? (
        <div className={styles.notice} data-tone="error">
          <span className={styles.text}>本地存储异常：{storageError}</span>
          <button
            type="button"
            className={styles.close}
            onClick={() => setStorageDismissed(true)}
            aria-label="关闭"
          >
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      {chatError !== null ? (
        <div className={styles.notice} data-tone="error">
          <span className={styles.text}>{chatError}</span>
          <button type="button" className={styles.close} onClick={clearChatError} aria-label="关闭">
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      {workspaceError !== null ? (
        <div className={styles.notice} data-tone="error">
          <span className={styles.text}>{workspaceError}</span>
          <button
            type="button"
            className={styles.close}
            onClick={clearWorkspaceError}
            aria-label="关闭"
          >
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      {alerts.map((alert) => (
        <div key={alert.id} className={styles.notice} data-tone="alert">
          <span className={styles.text}>{alert.message}</span>
          <button
            type="button"
            className={styles.close}
            onClick={() => dismissAlert(alert.id)}
            aria-label="关闭"
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
