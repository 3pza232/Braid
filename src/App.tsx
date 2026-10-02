import { Suspense, lazy, useEffect } from 'react';
import { Composer } from '@ui/components/Composer';
import { MessageList } from '@ui/components/MessageList';
import { Notices } from '@ui/components/Notices';
import { Sidebar } from '@ui/components/Sidebar';
import { TopBar } from '@ui/components/TopBar';
import { useBalanceStore } from '@ui/stores/balanceStore';
import { useChatStore } from '@ui/stores/chatStore';
import { useRolesStore } from '@ui/stores/rolesStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useUiStore } from '@ui/stores/uiStore';
import { useWorkspaceStore } from '@ui/stores/workspaceStore';
import { useContainer } from '@ui/BraidProvider';
import styles from './App.module.css';

/*
 * 三个面板按需加载
 *
 * 它们合计约 90KB 源码，而用户**日常聊天时一个都不会打开** ——
 * 打进主包意味着每次启动（含开发时的每次刷新）都为它们付出解析代价。
 * 拆成独立 chunk 后，只有在真正打开设置/角色时才下载执行。
 *
 * 副作用是首次打开面板会有一瞬间的空档（本地文件几乎察觉不到），
 * 所以 fallback 用 null 而不是转圈：面板是覆盖层，闪一下比先出现一个
 * 会跳动的加载圈更不打扰。
 */
const SettingsPanel = lazy(() =>
  import('@ui/panels/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
);
const ConversationSettingsPanel = lazy(() =>
  import('@ui/panels/ConversationSettingsPanel').then((module) => ({
    default: module.ConversationSettingsPanel,
  })),
);
const RolesPanel = lazy(() =>
  import('@ui/panels/RolesPanel').then((module) => ({ default: module.RolesPanel })),
);

/**
 * 应用外壳
 *
 * 除了布局，它还承担两件"全局但很薄"的职责：
 *  1. 把组合根里的服务绑定给 UI store（唯一一次）；
 *  2. 注册全局快捷键。
 */
export function App() {
  const container = useContainer();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const activePanel = useUiStore((s) => s.activePanel);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openPanel = useUiStore((s) => s.openPanel);
  const openRolesPanel = useUiStore((s) => s.openRolesPanel);
  const closePanel = useUiStore((s) => s.closePanel);

  const bindSettings = useSettingsStore((s) => s.bind);
  const bindRoles = useRolesStore((s) => s.bind);
  const bindBalance = useBalanceStore((s) => s.bind);
  const bindChat = useChatStore((s) => s.bind);
  const bindWorkspace = useWorkspaceStore((s) => s.bind);

  const density = useSettingsStore((s) => s.settings.appearance.messageDensity);
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion);
  const contentFontSize = useSettingsStore((s) => s.settings.appearance.contentFontSize);
  const bubbleStyle = useSettingsStore((s) => s.settings.appearance.bubbleStyle);

  useEffect(() => {
    // 顺序有讲究：余额服务要读设置里的脚本，所以设置先于余额绑定
    bindSettings(container.settings);
    bindRoles(container.roles);
    bindBalance(container.balance);
    bindChat(container.chat);
    bindWorkspace(container.workspace);
  }, [bindSettings, bindRoles, bindBalance, bindChat, bindWorkspace, container]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
      if (key === ',') {
        event.preventDefault();
        openPanel('global-settings');
      }
      if (key === 'r' && event.shiftKey) {
        event.preventDefault();
        openRolesPanel(null);
      }
      if (key === 'escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar, openPanel, openRolesPanel, closePanel]);

  return (
    <div
      className={styles.app}
      data-sidebar-collapsed={sidebarCollapsed}
      data-density={density}
      data-motion={reduceMotion ? 'reduced' : 'full'}
      data-font-size={contentFontSize}
      data-bubble={bubbleStyle}
    >
      <Sidebar />
      <main className={styles.main}>
        <TopBar />
        <MessageList />
        <Composer />
      </main>

      {/* 权限警报不属于任何面板，挂在根部才能"无论在看哪里都看得到" */}
      <Notices />

      <Suspense fallback={null}>
        {activePanel === 'global-settings' ? <SettingsPanel /> : null}
        {activePanel === 'conversation-settings' ? <ConversationSettingsPanel /> : null}
        {activePanel === 'roles' ? <RolesPanel /> : null}
      </Suspense>
    </div>
  );
}
