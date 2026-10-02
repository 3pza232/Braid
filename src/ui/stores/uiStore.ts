import { create } from 'zustand';
import type { ThemePreference } from '@ports/Theme';
import { readThemePreference, writeThemePreference } from '@ui/theme/themePreferenceStorage';

/**
 * UI 视图状态（只放"界面长什么样"）
 *
 * 纪律（分层与数据流见 docs/01-architecture.md、docs/08-ui.md）：
 * 这里**只允许**出现视图状态。任何业务动作（发消息、建会话、切分支、改设置）
 * 一律走 application 层的服务，绝不写进 store。
 * 这样业务逻辑可以脱离 React 单测，也让换 UI 框架时业务零改动。
 */
export type PanelId = 'none' | 'global-settings' | 'conversation-settings' | 'roles';

export type SidebarSection = 'conversations' | 'roles';

/**
 * 一条界面通知
 *
 * 【为什么要有这个通道】
 * 以前"要告诉用户点什么"有两个去处：`window.alert`（导出失败就这么干的）或
 * 塞进某个 store 的 error 字段（只有打开那个面板才看得到）。两者都有问题：
 * 前者打断且不可测，后者等于"看运气"。
 *
 * 通知是**界面状态**，所以放在视图 store 里，由 `Notices` 统一渲染 ——
 * 这样"什么时候该告诉用户"变成一次显式的 `pushNotice`，可读、可测、可复用。
 */
export interface Notice {
  id: string;
  tone: 'error' | 'alert';
  message: string;
  /**
   * 可选的一个动作（目前只有"撤销"）
   *
   * 【为什么用"通知 + 撤销"，而不是弹一句"确认吗"】
   * 对"一击就覆盖、覆盖的又是用户手写的东西"这类操作（恢复默认设置、清空余额脚本、
   * 删除模型配置…），确认框的代价是**每一次都要多按一下**（用户明确说过不喜欢），
   * 而它的收益只有"那一次你想反悔的时候"。撤销正好反过来：
   * 正常操作一次点击就过，只有真的做错了才需要那一下。
   *
   * 只有"动作可以如实复原"时才该给：复原不了的操作（比如已发送的请求）不给这个入口，
   * 那种情况下弹确认才是对的做法。
   */
  action?: { label: string; run: () => void };
}

interface UiState {
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  /** 侧栏两个分区各自的折叠状态 */
  sectionCollapsed: Record<SidebarSection, boolean>;
  toggleSection: (section: SidebarSection) => void;

  activePanel: PanelId;
  /** 打开角色面板时希望预选中的角色 */
  rolesPanelTargetId: string | null;
  openPanel: (panel: PanelId) => void;
  openRolesPanel: (roleId?: string | null) => void;
  openSettings: () => void;
  closePanel: () => void;

  /** 界面通知：由 `Notices` 统一展示（错误与提醒都走这里，不用 alert） */
  notices: Notice[];
  pushNotice: (notice: Omit<Notice, 'id'>) => void;
  dismissNotice: (id: string) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  themePreference: readThemePreference(),
  setThemePreference: (preference) => {
    // 当前会话一定生效；存不下则说一声 —— 否则用户会以为"选了却总被重置"
    if (!writeThemePreference(preference)) {
      get().pushNotice({
        tone: 'alert',
        message: '这次主题选择没能记住（浏览器不允许写入本地存储），下次打开会回到默认。',
      });
    }
    set({ themePreference: preference });
  },

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  sectionCollapsed: { conversations: false, roles: false },
  toggleSection: (section) =>
    set((s) => ({
      sectionCollapsed: { ...s.sectionCollapsed, [section]: !s.sectionCollapsed[section] },
    })),

  activePanel: 'none',
  rolesPanelTargetId: null,

  openPanel: (panel) => set({ activePanel: panel }),
  openRolesPanel: (roleId = null) => set({ activePanel: 'roles', rolesPanelTargetId: roleId }),
  openSettings: () => set({ activePanel: 'global-settings' }),
  closePanel: () => set({ activePanel: 'none' }),

  notices: [],
  pushNotice: ({ tone, message, action }) =>
    set((s) => ({
      // id 只用于 React key 与关闭：内容相同的两条通知也该能分别关掉
      notices: [
        ...s.notices,
        { id: `n-${Date.now().toString(36)}-${s.notices.length}`, tone, message, action },
      ],
    })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((item) => item.id !== id) })),
}));
