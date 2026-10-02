import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveConfig } from '@domain/rules/resolveConfig';
import { formatTokenCount } from '@domain/value-objects/usage';
import { activeSummaryOf } from '@domain/value-objects/contextSummary';
import { activePathOf, cachedTreeIndex } from '@domain/rules/messageTree';
import { useAnchoredLayer } from '@ui/hooks/useAnchoredLayer';
import { useChatStore } from '@ui/stores/chatStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { Tooltip } from '@ui/primitives';
import styles from './ContextMenu.module.css';

/**
 * 顶栏的上下文按钮与菜单
 *
 * 一个按钮承担三件事，因为它们回答的是同一个问题"现在上下文怎么样了"：
 *  1. **用量**：进度条 + 百分比，一眼看够不够；
 *  2. **会话详情**：条数、预算怎么算出来的、保留多少轮、压缩了几次；
 *  3. **压缩**：手动压一次，以及回看当前纪要的全文。
 *
 * 压缩按钮刻意放在这里而不是设置里：它是**当下这个会话**的动作，
 * 而不是一个全局偏好 —— 用户是在看到"快满了"的那一刻想压它。
 */
export function ContextMenu() {
  const conversation = useChatStore((s) => s.conversation);
  const tree = useChatStore((s) => s.tree);
  const status = useChatStore((s) => s.context);
  const note = useChatStore((s) => s.contextNote);
  const compressing = useChatStore((s) => s.compressing);
  const error = useChatStore((s) => s.error);
  const compress = useChatStore((s) => s.compressContext);
  const clearError = useChatStore((s) => s.clearError);
  const settings = useSettingsStore((s) => s.settings);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  /*
   * 定位与关闭逻辑与 `Dropdown` 同构，已统一在 `useAnchoredLayer`：
   * portal + fixed + 量触发元素 + 下方放不下就翻上去 + 点外面/Esc 关闭 + resize/滚动重算。
   */
  const {
    open,
    setOpen,
    anchor,
    triggerRef,
    layerRef: panelRef,
  } = useAnchoredLayer<HTMLButtonElement>({
    align: 'right',
    // 面板高度不固定（展开纪要会明显变高），报一个保守的上界即可
    estimateHeight: () => 300,
  });

  const config = resolveConfig(settings, conversation);
  const summary = activeSummaryOf(conversation);
  const path = activePathOf(cachedTreeIndex(tree.nodes), tree.activeRootChildId);
  const percent = Math.round(status.ratio * 100);
  const level = status.blocked || status.ratio >= 0.9 ? 'over' : status.ratio >= 0.7 ? 'near' : 'ok';

  const toggle = () => {
    setOpen((value) => !value);
    // 打开菜单时清掉上一次的发送错误：那条错误多半就是"上下文满了"，
    // 用户点开菜单正是来看这件事的，再挂着一句红字是重复信息
    if (!open && error) clearError();
  };

  return (
    <span className={styles.root} ref={rootRef}>
      <Tooltip label="上下文用量 · 点击查看详情与压缩">
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          data-level={level}
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <span className={styles.bar}>
            <span className={styles.fill} style={{ width: `${Math.min(100, status.ratio * 100)}%` }} />
          </span>
          <span className={styles.text}>
            {formatTokenCount(status.usedTokens)} / {formatTokenCount(status.budget)}
            <span className={styles.percent}>{percent}%</span>
          </span>
          {summary ? <span className={styles.badge}>已压缩</span> : null}
        </button>
      </Tooltip>

      {/*
        面板 portal 到 body
        它挂在顶栏里，而主区是 `overflow: hidden`（三个区域各管各的滚动）——
        留在原地会被**裁掉**，表现就是"菜单没浮在上层、被挡住了"。
        脱出去之后位置得自己算，所以下面用 fixed + 量到的坐标。
      */}
      {open && anchor
        ? createPortal(
            <div
              ref={panelRef}
              className={styles.panel}
              role="dialog"
              aria-label="上下文详情"
              style={{ right: anchor.right, top: anchor.top, bottom: anchor.bottom }}
            >
              <div className={styles.head}>上下文</div>

              {status.blocked ? (
                <p className={styles.warn}>已到上限：压缩一次，或把「上下文长度」调大。</p>
              ) : null}

              <dl className={styles.detail}>
                <div>
                  <dt>预计占用</dt>
                  <dd>
                    {formatTokenCount(status.usedTokens)} / {formatTokenCount(status.budget)}
                    <span className={styles.muted}> · {percent}%</span>
                  </dd>
                </div>
                <div>
                  <dt>消息</dt>
                  <dd>
                    {tree.nodes.filter((node) => node.deletedAt === null).length} 条 · 发送{' '}
                    {path.filter((node) => node.contextFlags?.summarized !== true).length} 条
                  </dd>
                </div>
                <div>
                  <dt>预算</dt>
                  <dd>
                    {formatTokenCount(config.maxContextTokens)} − 预留{' '}
                    {formatTokenCount(config.reservedForOutput)}
                  </dd>
                </div>
                <div>
                  <dt>保留原文</dt>
                  <dd>最近 {config.keepRecentTurns} 轮</dd>
                </div>
                <div>
                  <dt>压缩</dt>
                  <dd>
                    {config.compression === 'auto'
                      ? `自动 · ${Math.round(config.compressAt * 100)}%`
                      : '手动'}
                    {status.summaryCount > 0
                      ? ` · 已压 ${status.summaryCount} 次 · 纪要 ${formatTokenCount(status.summaryTokens)}`
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{config.model || '未配置'}</dd>
                </div>
              </dl>

              {note ? <p className={styles.note}>{note}</p> : null}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.compress}
                  disabled={compressing || tree.nodes.length === 0}
                  onClick={() => void compress()}
                >
                  {compressing ? '压缩中…' : '压缩上下文'}
                </button>
                {summary ? (
                  <button
                    type="button"
                    className={styles.ghost}
                    onClick={() => setSummaryOpen((value) => !value)}
                    aria-expanded={summaryOpen}
                  >
                    {summaryOpen ? '收起纪要' : '查看纪要'}
                  </button>
                ) : null}
              </div>

              {summary ? (
                <div className={styles.summaryMeta}>
                  纪要覆盖 {summary.coveredCount} 条
                  {summary.modelRef ? ` · ${summary.modelRef}` : ''}
                </div>
              ) : null}

              {summary && summaryOpen ? <pre className={styles.summary}>{summary.text}</pre> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
