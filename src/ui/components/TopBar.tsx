import { useEffect, useMemo, useState } from 'react';
import { resolveConfig } from '@domain/rules/resolveConfig';
import { formatMoney } from '@domain/value-objects/billing';
import { activeProfileOf } from '@domain/value-objects/appSettings';
import { ContextMenu } from './ContextMenu';
import type { WritingMode } from '@domain/value-objects/writingMode';
import { IconButton, Tooltip } from '@ui/primitives';
import { useContainer } from '@ui/BraidProvider';
import { useBalanceStore } from '@ui/stores/balanceStore';
import { useChatStore } from '@ui/stores/chatStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useUiStore } from '@ui/stores/uiStore';
import { useWorkspaceStore } from '@ui/stores/workspaceStore';
import { IconExport, IconFolder, IconSettings, IconSpark, IconWallet } from './Icons';
import styles from './TopBar.module.css';

const MODE_LABEL: Record<WritingMode | 'chat', string> = {
  chat: '普通',
  short: '短',
  medium: '中',
  long: '长',
};

/**
 * 顶栏
 *
 * 从左到右：标题 · 工作区 · 角色 · 模型 · 档位 ·──· 上下文用量 · 余额 · 会话设置。
 *
 * 这一行**只做展示**：角色名与余额都是状态指示，不是下拉入口
 * （切角色属于会话创建时的事，改角色属于角色面板里的事）。
 */
export function TopBar() {
  const container = useContainer();
  const conversation = useChatStore((s) => s.conversation);
  const workspace = useWorkspaceStore((s) => s.snapshot);
  const selectWorkspace = useWorkspaceStore((s) => s.selectDirectory);
  const authorizeWorkspace = useWorkspaceStore((s) => s.reauthorize);
  const settings = useSettingsStore((s) => s.settings);
  const openPanel = useUiStore((s) => s.openPanel);
  const pushNotice = useUiStore((s) => s.pushNotice);

  const snapshot = useBalanceStore((s) => s.snapshot);
  const balanceBusy = useBalanceStore((s) => s.busy);
  const refreshBalance = useBalanceStore((s) => s.refresh);

  const config = useMemo(() => resolveConfig(settings, conversation), [settings, conversation]);

  // 余额配置跟着模型配置走（不同端点的余额接口完全不同）
  const profile = activeProfileOf(settings);
  const autoRefresh = profile?.balance.autoRefresh ?? false;
  const interval = profile?.balance.refreshIntervalMs ?? 60_000;
  const hasScript = (profile?.balance.script.trim().length ?? 0) > 0;
  useEffect(() => {
    if (!autoRefresh || !hasScript || interval <= 0) return;
    const timer = window.setInterval(refreshBalance, Math.max(10_000, interval));
    return () => window.clearInterval(timer);
  }, [autoRefresh, hasScript, interval, refreshBalance]);

  const roleName = conversation.roleInstance?.name ?? null;
  /** 导出进行中：期间禁用入口（大库拼 JSON 要几秒，连点会重复导出） */
  const [exporting, setExporting] = useState(false);

  /**
   * 导出全部数据
   *
   * 失败与"用户取消"要分开处理：取消是他自己的选择，弹一句红字只会让人以为出了问题。
   */
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      /*
       * 先让浏览器画一帧再开始拼
       *
       * 导出要把整个库拼成一个大 JSON，是同步的重活：不先让出这一次，
       * 界面会一直停在"按下去没反应"的状态（连按钮的忙碌态都刷不出来），
       * 用户很容易以为按钮坏了、于是再点几次。
       */
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      const exported = await container.backup.exportAll();
      if (!exported.ok) {
        // 走统一的通知通道：不再用 window.alert（打断式、且测不了）
        pushNotice({ tone: 'error', message: `导出失败：${exported.error.message}` });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const saved = await container.fileDialog.saveText(
        `braid-backup-${stamp}.json`,
        exported.data,
      );
      if (!saved.ok) pushNotice({ tone: 'error', message: `保存失败：${saved.error.message}` });
    } finally {
      setExporting(false);
    }
  };

  /*
   * 工作区
   *
   * 这里显示的是**目录名而不是路径**：浏览器只给句柄不给路径。
   * 顶栏原本显示的 `conversation.workspaceRoot` 现在存的是句柄令牌，
   * 直接显示会是一串 `fsw-xxx` —— 所以必须换成从工作区服务解析出来的展示名。
   */
  const workspaceNeedsGrant =
    workspace.handleState === 'prompt' || workspace.handleState === 'denied';
  const workspaceLabel =
    workspace.root === null ? '未选择工作区' : workspace.root.label;
  const workspaceHint = !workspace.supported
    ? (workspace.unsupportedReason ?? '当前环境不支持访问本地目录')
    : workspace.root === null
      ? '点击选择一个本地目录作为本会话的工作区\n选好后 AI 可以在里面读写'
      : workspaceNeedsGrant
        ? `工作区：${workspace.root.label}\n浏览器重启后需要你点一下重新授权`
        : `工作区：${workspace.root.label}\n点击可更换目录。AI 文件工具只能访问这个目录内的内容`;

  return (
    <header className={styles.topbar}>
      <div className={styles.title}>{conversation.title}</div>

      <span className={styles.sep} aria-hidden="true" />

      <Tooltip label={workspaceHint}>
        <button
          type="button"
          className={styles.chip}
          data-empty={workspace.root === null}
          disabled={!workspace.supported}
          onClick={() => void (workspaceNeedsGrant ? authorizeWorkspace() : selectWorkspace())}
        >
          <IconFolder size={14} />
          <span className={styles.chipText}>{workspaceLabel}</span>
          {/* 需要授权是个**必须显形**的状态：否则用户只会觉得"文件功能坏了" */}
          {workspaceNeedsGrant ? <span className={styles.chipWarn}>需授权</span> : null}
        </button>
      </Tooltip>

      <Tooltip
        label={
          roleName
            ? `本会话使用的角色：${roleName}\n角色预设的改动不会影响已开始的对话（会话用的是创建时的快照）`
            : '本会话没有使用角色，直接继承全局设置'
        }
      >
        <span className={styles.chip} data-empty={!roleName}>
          <IconSpark size={14} />
          <span className={styles.chipText}>{roleName ?? '无角色'}</span>
        </span>
      </Tooltip>

      <Tooltip
        label={
          config.model
            ? `${config.model}（来源：${
                config.sources.model === 'conversation'
                  ? '本会话'
                  : config.sources.model === 'role'
                    ? '角色'
                    : '全局'
              }）`
            : '尚未指定模型 —— 到「设置 → 模型与凭据」添加一个'
        }
      >
        <span className={styles.model} data-empty={!config.model}>
          {config.model || '未指定模型'}
        </span>
      </Tooltip>

      <Tooltip
        label={
          config.writingMode === 'chat'
            ? '普通对话：单次生成，不自动续写'
            : `续写 · ${MODE_LABEL[config.writingMode]}：自动续写直到 ${config.minOutputChars.toLocaleString()} 字`
        }
      >
        <span className={styles.mode} data-mode={config.writingMode}>
          {MODE_LABEL[config.writingMode]}
        </span>
      </Tooltip>

      <div className={styles.spacer} />

      {/*
        上下文：按钮 + 菜单（用量、会话详情、压缩、纪要回看）
        它自己从 store 取数据，所以这里不再需要把用量算一遍传进去 ——
        顶部这一行只负责"把东西按顺序摆好"。
      */}
      <ContextMenu />

      <Tooltip
        label={
          !hasScript
            ? '未配置余额查询脚本（在设置 → 模型与凭据里配置）'
            : balanceBusy
              ? '正在查询…'
              : snapshot?.error
                ? `查询失败：${snapshot.error}`
                : `更新于 ${new Date(snapshot?.fetchedAt ?? 0).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`
        }
      >
        <button
          type="button"
          className={styles.balance}
          data-state={!hasScript ? 'unset' : balanceBusy ? 'busy' : snapshot?.isValid ? 'ok' : 'error'}
          onClick={() => refreshBalance()}
        >
          <IconWallet size={14} />
          {balanceBusy ? (
            <span className={styles.miniSpinner} />
          ) : (
            <span className={styles.balanceText}>
              {!hasScript
                ? '余额'
                : snapshot?.remaining != null
                  ? formatMoney(snapshot.remaining, snapshot.unit)
                  : '—'}
            </span>
          )}
        </button>
      </Tooltip>

      {/*
        导出全部数据
        放在这一行里而不是设置面板里，是因为它的性质是"救数据"：
        换机器、清浏览器之前要能一眼找到，而不是翻三层菜单。
      */}
      <IconButton
        label={exporting ? '正在导出…' : '导出全部数据'}
        size={30}
        disabled={exporting}
        onClick={handleExport}
      >
        <IconExport size={16} />
      </IconButton>

      <IconButton
        label="本会话设置"
        size={30}
        onClick={() => openPanel('conversation-settings')}
      >
        <IconSettings size={16} />
      </IconButton>
    </header>
  );
}
