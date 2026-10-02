import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_CONVERSATION_TITLE_LENGTH, type Conversation } from '@domain/entities/conversation';
import type { ConversationId } from '@shared/ids';
import type { ThemePreference } from '@ports/Theme';
import { useChatStore } from '@ui/stores/chatStore';

import { useRolesStore } from '@ui/stores/rolesStore';
import { useUiStore } from '@ui/stores/uiStore';
import { stashImportSummary } from '@ui/utils/importSummary';
import { useTheme } from '@ui/theme/ThemeProvider';
import { DragHandle, Dropdown, IconButton, Tooltip } from '@ui/primitives';
import { Avatar } from './Avatar';
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevron,
  IconExport,
  IconImport,
  IconMonitor,
  IconMoon,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
} from './Icons';
import { useContainer } from '@ui/BraidProvider';
import { useDragReorder } from '@ui/hooks/useDragReorder';
import { matchesQuery } from '@domain/rules/fuzzyMatch';

import styles from './Sidebar.module.css';

/**
 * 侧栏
 *
 * 两个**各自可折叠**的区块：上「会话」、下「角色预设」。
 *
 * 会话行：**单击切换**、双击进入重命名、悬停出操作条。
 * 删除做成两步（点垃圾桶 → 出现「删除 / 取消」），因为删除整场对话不可逆，
 * 一次误点就丢一整条消息树。
 *
 * 角色行的行为：**点击 = 进入该角色的详情面板**（不是"绑定到当前会话"）。
 * 因为角色与会话是"预制体 / 实例"关系：改角色不会影响已有会话，
 * 想用某个角色开新对话，在角色详情面板底部点「开始对话」。
 */
export function Sidebar() {
  const container = useContainer();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const sectionCollapsed = useUiStore((s) => s.sectionCollapsed);
  const toggleSection = useUiStore((s) => s.toggleSection);
  const openSettings = useUiStore((s) => s.openSettings);
  const openRolesPanel = useUiStore((s) => s.openRolesPanel);
  const pushNotice = useUiStore((s) => s.pushNotice);

  const { themes, preference, setPreference } = useTheme();

  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const activeConversation = useChatStore((s) => s.conversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const startConversationWithRole = useChatStore((s) => s.startConversationWithRole);
  const locateMessage = useChatStore((s) => s.locateMessage);
  const searchCursor = useChatStore((s) => s.searchCursor);
  const setSearchCursor = useChatStore((s) => s.setSearchCursor);
  const reorderConversations = useChatStore((s) => s.reorderConversations);

  const roles = useRolesStore((s) => s.roles);
  const createRole = useRolesStore((s) => s.create);
  const importRole = useRolesStore((s) => s.importJson);
  const reorderRoles = useRolesStore((s) => s.reorder);

  /* ── 纯视图状态：不进 store，因为它只服务于这一个组件的渲染 ── */
  const [renamingId, setRenamingId] = useState<ConversationId | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingId, setConfirmingId] = useState<ConversationId | null>(null);
  /**
   * 搜索词是**纯视图状态**：它只决定"列表显示哪几条"，不进数据库、
   * 也不影响别的组件 —— 放进 store 反而要处理"切换会话后要不要清空"这种问题
   */
  const [query, setQuery] = useState('');
  /** 角色名筛选：与会话搜索同一套匹配规则，但各管各的列表 */
  const [roleQuery, setRoleQuery] = useState('');
  /**
   * 搜索范围：标题 / 正文
   *
   * 默认标题 —— 绝大多数时候用户找的是"聊那次的那条"，按标题最快。
   * 正文搜索要过一遍数据库，不该是默认动作。
   */
  const [scope, setScope] = useState<'title' | 'body'>('title');
  const searchHits = useChatStore((s) => s.searchHits);
  const searchMessages = useChatStore((s) => s.searchMessages);
  const clearSearchHits = useChatStore((s) => s.clearSearchHits);

  /*
   * 正文搜索防抖
   *
   * 每敲一个字都查一次库，既浪费又会让结果列表来回跳。
   * 220ms 是"打完一个词"和"感觉即时"之间的常见折中。
   */
  useEffect(() => {
    if (scope !== 'body') return;
    /*
     * 依赖里**刻意没有** `activeId`
     *
     * 结果是跨会话的，与"当前打开哪条会话"无关。把它写进依赖会带来一个
     * 直接的功能冲突：跟着命中切会话（见 followHit）会触发重搜，
     * 而重搜会清掉"当前聚焦哪一处"—— 于是跳过去的那一下立刻被自己撤销。
     */
    const timer = window.setTimeout(() => searchMessages(query), 220);
    return () => window.clearTimeout(timer);
  }, [query, scope, searchMessages]);

  // 切回标题搜索时把上一次的正文命中清掉，免得残留的命中影响着色/计数
  useEffect(() => {
    if (scope === 'title') clearSearchHits();
  }, [scope, clearSearchHits]);


  /**
   * 会话列表的筛选
   *
   * 只**按标题**筛。正文搜索的范围是当前会话（见 messageSearch.ts 的说明），
   * 它不参与这条列表 —— 早先这里按"哪些会话命中"过滤，范围收窄之后
   * 那个条件根本不存在，留着只会把列表筛空。
   *
   * 匹配算法在 domain（纯函数可测）：子串命中 + 按顺序的子序列命中。
   */
  /** 有命中的会话集合（列表收窄与计数共用） */
  const bodyMatchedIds = useMemo(
    () => new Set(searchHits.map((hit) => hit.conversationId)),
    [searchHits],
  );

  const visibleConversations = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return conversations;
    if (scope === 'title') return conversations.filter((item) => matchesQuery(item.title, trimmed));
    // 正文搜索跨会话，列表收窄到"有命中的会话"：这是"哪几条会话里有这句话"的答案
    return conversations.filter((item) => bodyMatchedIds.has(item.id));
  }, [conversations, query, scope, bodyMatchedIds]);

  /**
   * 当前那一处命中所属的会话标题
   *
   * 跨会话搜索时"第 3/12 处"本身说明不了它在哪 —— 用户需要知道
   * 按「下一处」会把他带到哪条会话去。
   */
  const currentHitTitle = useMemo(() => {
    const hit = searchCursor >= 0 ? searchHits[searchCursor] : undefined;
    if (!hit) return '';
    return conversations.find((item) => item.id === hit.conversationId)?.title ?? '';
  }, [searchHits, searchCursor, conversations]);

  /*
   * 拖动排序：传的是**当前可见顺序**
   *
   * 被搜索过滤掉的那些不在列表里，因此保持原编号不动 ——
   * 给看不见的东西重编号，等于用户每次拖动都在悄悄改动他没看到的东西。
   */
  const conversationsDrag = useDragReorder(
    visibleConversations.map((item) => item.id),
    reorderConversations,
  );
  const renameCancelled = useRef(false);
  /** 备份导入进行中：期间禁用入口，避免连点导致导入两遍 */
  const [importing, setImporting] = useState(false);

  /**
   * 从备份文件导入
   *
   * 导入动的是"库里的全部数据"，而内存里的会话列表、消息树、角色都还是旧的。
   * 与其在十几个地方做失效通知，不如导完直接重新加载 —— 对本地应用来说，
   * 一次刷新只要一两百毫秒，而且不可能漏掉什么。
   */
  const handleImportBackup = async () => {
    if (importing) return;
    const picked = await container.fileDialog.openText('Braid 备份文件', ['.json']);
    if (!picked.ok) {
      pushNotice({ tone: 'error', message: `导入失败：${picked.error.message}` });
      return;
    }
    if (picked.data === null) return; // 用户取消

    /*
     * 导入要写几千条消息，可能持续好几秒
     *
     * 期间既没有进度也没有禁用：用户会以为没反应，于是再点一次 —— 那就导入两遍。
     */
    setImporting(true);
    try {
      const imported = await container.backup.importAll(picked.data);
      if (!imported.ok) {
        pushNotice({ tone: 'error', message: `导入失败：${imported.error.message}` });
        return;
      }

      const summary = imported.data;
      const notes = [
        `已导入 ${summary.conversationCount} 个会话、${summary.messageCount} 条消息、${summary.roleCount} 个角色。`,
      ];
      // 跳过与丢弃必须说出来：用户有权知道自己少拿了什么
      if (summary.skipped > 0) notes.push(`有 ${summary.skipped} 条数据格式不完整，已跳过。`);
      if (summary.droppedMessages > 0) {
        notes.push(`有 ${summary.droppedMessages} 条消息因所属会话不在备份里，已丢弃。`);
      }
      const message = notes.join('；'); // 通知条是一行文字，换行会被压成空白

      /*
       * 汇总要**带过重载**再告诉他
       *
       * 紧接着就是 `location.reload()`，通知条会被立刻冲掉 ——
       * 而这些话只在这一刻有用（数据有没有少，全看它）。所以寄存在 sessionStorage，
       * 刷新后由启动流程重新推出来（见 `ui/utils/importSummary` 与 `main.tsx`）。
       */
      stashImportSummary(message);
      pushNotice({ tone: 'alert', message });
      window.setTimeout(() => window.location.reload(), 400);
    } finally {
      setImporting(false);
    }
  };

  const activeRoleId = activeConversation.roleInstance?.roleId ?? null;

  /**
   * 新建会话时沿用当前会话的角色
   *
   * 因为"再开一场"十有八九还是用同一个角色。传 null 则是空白会话。
   */
  const newConversation = () => {
    const role = roles.find((item) => item.id === activeConversation.roleId) ?? null;
    void startConversationWithRole(role);
  };

  /** 角色名模糊筛选（与侧栏会话搜索同一套规则） */
  const visibleRoles = useMemo(() => {
    const trimmed = roleQuery.trim();
    if (trimmed.length === 0) return roles;
    return roles.filter((role) => matchesQuery(role.name, trimmed));
  }, [roles, roleQuery]);

  /** 角色拖动排序：与会话同理，传当前可见顺序 */
  const rolesDrag = useDragReorder(
    visibleRoles.map((role) => role.id),
    reorderRoles,
  );

  /**
   * 从 JSON 文件导入一个角色
   *
   * 与角色面板里的「导入」是同一件事、同一个入口 —— 侧栏是角色列表的常驻视图，
   * 用户在这里看到"少了一个角色"时，不该被要求先打开面板才能导。
   */
  const handleImportRole = async () => {
    const picked = await container.fileDialog.openText('角色预设 JSON', ['.json']);
    if (!picked.ok) {
      pushNotice({ tone: 'error', message: `导入失败：${picked.error.message}` });
      return;
    }
    if (picked.data === null) return; // 用户取消
    const created = await importRole(picked.data);
    if (created) {
      openRolesPanel(created.id);
      return;
    }
    /*
     * 走到这里说明解析或落库失败了，**必须说出来**
     *
     * 早先这里直接 return，界面毫无变化 —— 用户只会以为"点了没反应"。
     * 真正的错误文本在 `rolesStore.error` 里，而它只在角色面板内展示，
     * 侧栏导入的人根本不会想到去那儿找。
     * 用 `getState()` 现取而不是从渲染闭包里拿：那个值还是调用前的旧值。
     */
    pushNotice({
      tone: 'error',
      message: `导入失败：${useRolesStore.getState().error ?? '文件内容不是合法的角色预设'}`,
    });
  };

  /**
   * 跳到第 `index` 处命中
   *
   * 命中可能来自别的会话，所以这一步要**顺带切会话**。
   * 切过去一定看得见：搜索已经把落在旧分支上的命中滤掉了（见 messageSearch.ts），
   * 所以这里不存在"切过去还是空白"的情况 —— 那是老实现的问题，不是这个跳转的。
   */
  const followHit = (index: number) => {
    const hit = searchHits[index];
    if (!hit) return;
    setSearchCursor(index);
    // 命中里的会话 id 直接来自消息节点，本身就是品牌类型，不必再转换
    if (hit.conversationId !== activeId) selectConversation(hit.conversationId);
    locateMessage(hit);
  };

  /**
   * 导出这条会话为 Markdown 文件
   *
   * 文本由 domain 的纯函数生成（只导出当前激活的那条线，见 conversationMarkdown.ts），
   * 这里只负责"挑文件、写文件、把结果说清楚" —— 与顶栏导出备份同一套做法。
   * 走 `container.chat` 而不是 store：它不改动任何会话状态，不需要经 store 中转
   * （状态变更才必须走 store，否则同一份状态会有两个来源）。
   */
  const exportConversation = async (item: Conversation) => {
    const markdown = await container.chat.exportConversation(item.id);
    if (!markdown.ok) {
      pushNotice({ tone: 'error', message: `导出失败：${markdown.error.message}` });
      return;
    }

    // 标题可能带路径分隔符/通配符，直接当文件名会写到别处或失败
    const safeName = (item.title || '未命名会话').replace(/[\\/:*?"<>|]/g, '_');
    const saved = await container.fileDialog.saveText(`${safeName}.md`, markdown.data);
    if (!saved.ok) {
      pushNotice({ tone: 'error', message: `保存失败：${saved.error.message}` });
      return;
    }
    // data 为假 = 用户取消了，不该弹任何提示
    if (saved.data) pushNotice({ tone: 'alert', message: '已导出为 Markdown 文件' });
  };

  /**
   * 打开一条会话
   *
   * 正文搜索模式下顺手跳到它**第一处**命中：用户点这条会话，
   * 十有八九就是因为里面有那句话。
   */
  const openConversation = (item: Conversation) => {
    selectConversation(item.id);
    if (scope !== 'body') return;
    const index = searchHits.findIndex((hit) => hit.conversationId === item.id);
    if (index >= 0) followHit(index);
  };

  /**
   * 前后跳一处
   *
   * 还没定位过时（`searchCursor` 为 -1）视为"在第一条之前"：
   * 点「下一处」从第一条开始，点「上一处」无处可去（按钮本身也是灰的）。
   */
  const stepHit = (delta: number) => {
    const from = searchCursor < 0 ? (delta > 0 ? -1 : 0) : searchCursor;
    followHit(from + delta); // 越界的下标由 followHit 忽略
  };

  const beginRename = (item: Conversation) => {
    renameCancelled.current = false;
    setRenameDraft(item.title);
    setRenamingId(item.id);
  };

  const commitRename = (id: ConversationId) => {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      setRenamingId(null);
      return;
    }
    const title = renameDraft.trim();
    if (title.length > 0) renameConversation(id, title);
    setRenamingId(null);
  };

  const themeOptions = [
    { id: 'system' as const, name: '跟随系统', icon: <IconMonitor size={15} /> },
    ...themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      icon: theme.colorScheme === 'dark' ? <IconMoon size={15} /> : <IconSun size={15} />,
    })),
  ];

  const cycleTheme = () => {
    const index = themeOptions.findIndex((option) => option.id === preference);
    const next = themeOptions[(index + 1) % themeOptions.length];
    if (next) setPreference(next.id);
  };

  if (collapsed) {
    return (
      <aside className={styles.sidebar} data-collapsed="true">
        <span className={styles.mark} aria-hidden="true">
          󰚄
        </span>
        <IconButton label="展开侧栏 (Ctrl+B)" size={30} onClick={() => setCollapsed(false)}>
          <span className={styles.chevron}>
            <IconChevron size={14} />
          </span>
        </IconButton>

        <Tooltip label="新建会话">
          <button
            type="button"
            className={styles.railNew}
            aria-label="新建会话"
            onClick={newConversation}
          >
            <IconPlus size={16} />
          </button>
        </Tooltip>

        <div className={styles.railGroup}>
          {conversations.map((item) => (
            <Tooltip key={item.id} label={item.title} side="bottom">
            <button
              type="button"
              className={styles.railItem}
              data-active={item.id === activeId}
              aria-label={item.title}
              onClick={() => openConversation(item)}
            >
              <span className={styles.railDot} />
            </button>
            </Tooltip>
          ))}
        </div>

        <div className={styles.railDivider} />

        <div className={styles.railGroup}>
          {roles.map((role) => (
            <Tooltip key={role.id} label={role.name}>
              <button
                type="button"
                className={styles.railAvatar}
                data-active={activeRoleId === role.id}
                onClick={() => openRolesPanel(role.id)}
                aria-label={`角色 ${role.name}`}
              >
                <Avatar avatar={role.avatar} name={role.name} size={32} />
              </button>
            </Tooltip>
          ))}
        </div>

        <div className={styles.railFooter}>
          <IconButton
            label={`主题：${themeOptions.find((o) => o.id === preference)?.name ?? ''}`}
            size={30}
            onClick={cycleTheme}
          >
            {themeOptions.find((o) => o.id === preference)?.icon}
          </IconButton>
          <IconButton label="全局设置 (Ctrl+,)" size={30} onClick={() => openSettings()}>
            <IconSettings size={16} />
          </IconButton>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          󰚄
        </span>
        <span className={styles.brandName}>Braid</span>
        <IconButton label="收起侧栏 (Ctrl+B)" size={28} onClick={() => setCollapsed(true)}>
          <span className={styles.chevron}>
            <IconChevron size={14} />
          </span>
        </IconButton>
      </div>

      {/* ── 会话 ── */}
      <section className={styles.section} data-collapsed={sectionCollapsed.conversations}>
        <div className={styles.sectionHead}>
          <button
            type="button"
            className={styles.sectionToggle}
            onClick={() => toggleSection('conversations')}
            aria-expanded={!sectionCollapsed.conversations}
          >
            <span className={styles.sectionChevron} data-open={!sectionCollapsed.conversations}>
              <IconChevron size={13} />
            </span>
            <span className={styles.sectionLabel}>会话</span>
            <span className={styles.sectionCount}>
              {query.trim().length > 0
                ? `${visibleConversations.length}/${conversations.length}`
                : conversations.length}
            </span>
          </button>
          <Tooltip label={importing ? '正在导入…' : '导入备份（追加，不覆盖）'}>
            <IconButton
              label={importing ? '正在导入' : '导入备份'}
              size={24}
              disabled={importing}
              onClick={handleImportBackup}
            >
              <IconImport size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label="新建会话">
            <IconButton label="新建会话" size={24} onClick={newConversation}>
              <IconPlus size={14} />
            </IconButton>
          </Tooltip>
        </div>

        {!sectionCollapsed.conversations ? (
          <>
            {/*
              搜索行：输入框与范围切换并排
              切换按钮刻意放在 <label> **外面** —— label 会把点击转给输入框，
              按钮放在里面就会出现"点切换等于点输入框"的怪事。
            */}
            <div className={styles.searchRow}>
              <label className={styles.search}>
                <IconSearch size={14} />
                <input
                  type="search"
                  value={query}
                  placeholder={scope === 'title' ? '搜索会话标题' : '搜索会话正文'}
                  aria-label={scope === 'title' ? '搜索会话标题' : '搜索会话正文'}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <Tooltip
                label={
                  scope === 'title'
                    ? '当前按标题搜索 · 点击改为搜索正文'
                    : '当前按正文搜索 · 点击改回搜索标题'
                }
              >
                <button
                  type="button"
                  className={styles.scopeBtn}
                  data-active={scope === 'body'}
                  onClick={() => setScope((value) => (value === 'title' ? 'body' : 'title'))}
                >
                  {scope === 'title' ? '标题' : '正文'}
                </button>
              </Tooltip>
            </div>
            {scope === 'body' && query.trim().length > 0 ? (
              <div className={styles.searchHint}>
                <span className={styles.searchHintText}>
                  {searchHits.length > 0
                    ? searchCursor < 0
                      ? `${bodyMatchedIds.size} 个会话 · ${searchHits.length} 处命中`
                      : `第 ${searchCursor + 1}/${searchHits.length} 处${currentHitTitle ? ` · ${currentHitTitle}` : ''}`
                    : '正文里没有匹配'}
                </span>
                {searchHits.length > 0 ? (
                  <>
                    {/* 提示统一走应用自己的浮层：原生 title 是慢半拍、不跟主题的另一套 */}
                    <Tooltip label="上一处命中">
                      <button
                        type="button"
                        className={styles.stepBtn}
                        disabled={searchCursor <= 0}
                        onClick={() => stepHit(-1)}
                        aria-label="上一处命中"
                      >
                        <IconArrowLeft size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label="下一处命中">
                      <button
                        type="button"
                        className={styles.stepBtn}
                        disabled={searchCursor >= searchHits.length - 1}
                        onClick={() => stepHit(1)}
                        aria-label="下一处命中"
                      >
                        <IconArrowRight size={13} />
                      </button>
                    </Tooltip>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* 投放判定挂在容器上（含最后一行下方的空白），行用 data-drag-id 标出边界 */}
            <div className={styles.list} {...conversationsDrag.listProps}>
              {/*
                空态也要有话说
                角色区一直有（"还没有任何角色…"），会话区却没有 —— 列表空着又没有任何
                指引时，用户看到的就是"这里什么都没有"，不知道下一步该做什么。
              */}
              {visibleConversations.length === 0 ? (
                <p className={styles.listEmpty}>
                  {query.trim().length > 0 ? '没有匹配的会话。' : '还没有会话，点上方 + 新建一个。'}
                </p>
              ) : null}
              {visibleConversations.map((item) => (
              <div
                key={item.id}
                className={styles.item}
                data-drag-id={item.id}
                data-active={item.id === activeId}
                data-confirming={confirmingId === item.id}
                data-dragging={conversationsDrag.draggingId === item.id}
                data-over={conversationsDrag.overId === item.id}
              >
                {/*
                  拖动手柄独立于整行：行要响应单击（切换）与双击（重命名），
                  整行可拖会让这两种操作变脆。
                */}
                <DragHandle
                  placement="gutter"
                  {...conversationsDrag.handleProps(item.id, `拖动调整「${item.title}」的顺序`)}
                />
                {renamingId === item.id ? (
                  <input
                    className={styles.renameInput}
                    value={renameDraft}
                    autoFocus
                    /* 上限与会话设置面板同一个常量：超长标题会撑破侧栏与顶栏那一行 */
                    maxLength={MAX_CONVERSATION_TITLE_LENGTH}
                    aria-label="重命名会话"
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(item.id);
                      if (event.key === 'Escape') {
                        renameCancelled.current = true;
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => commitRename(item.id)}
                  />
                ) : (
                  <>
                    {/*
                      会话行**不挂悬停浮层**（用户明确要求去掉）：
                      鼠标扫过列表时不断冒出来的提示比"看不到完整标题"更烦人。
                    */}
                    <button
                      type="button"
                      className={styles.itemMain}
                      onClick={() => openConversation(item)}
                      onDoubleClick={() => beginRename(item)}
                    >
                      {item.roleInstance ? (
                        <span
                          className={styles.roleDot}
                          style={{
                            background:
                              item.roleInstance.avatar.color || 'var(--color-accent-default)',
                          }}
                        />
                      ) : null}
                      <span className={styles.itemTitle}>{item.title}</span>
                    </button>

                    {confirmingId === item.id ? (
                      <span className={styles.actionsConfirm}>
                        <button
                          type="button"
                          className={styles.confirmYes}
                          onClick={() => {
                            deleteConversation(item.id);
                            setConfirmingId(null);
                          }}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          className={styles.confirmNo}
                          onClick={() => setConfirmingId(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className={styles.itemTime}>{relativeTime(item.updatedAt)}</span>
                        <span className={styles.itemActions}>
                          <IconButton
                            label="重命名"
                            size={24}
                            onClick={() => beginRename(item)}
                          >
                            <IconPencil size={13} />
                          </IconButton>
                          <IconButton
                            label="导出这条会话为 Markdown"
                            size={24}
                            onClick={() => void exportConversation(item)}
                          >
                            <IconExport size={13} />
                          </IconButton>
                          <IconButton
                            label="删除会话"
                            size={24}
                            onClick={() => setConfirmingId(item.id)}
                          >
                            <IconTrash size={13} />
                          </IconButton>
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
            </div>
          </>
        ) : null}
      </section>

      {/* ── 角色预设 ── */}
      <section className={styles.section} data-collapsed={sectionCollapsed.roles}>
        <div className={styles.sectionHead}>
          <button
            type="button"
            className={styles.sectionToggle}
            onClick={() => toggleSection('roles')}
            aria-expanded={!sectionCollapsed.roles}
          >
            <span className={styles.sectionChevron} data-open={!sectionCollapsed.roles}>
              <IconChevron size={13} />
            </span>
            <span className={styles.sectionLabel}>角色预设</span>
            <span className={styles.sectionCount}>{roles.length}</span>
          </button>
          <Tooltip label="从 JSON 文件导入角色">
            <IconButton label="导入角色" size={24} onClick={handleImportRole}>
              <IconImport size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label="新建角色">
            <IconButton
              label="新建角色"
              size={24}
              onClick={() => {
                void createRole().then((role) => {
                  if (role) openRolesPanel(role.id);
                });
              }}
            >
              <IconPlus size={14} />
            </IconButton>
          </Tooltip>
        </div>

        {!sectionCollapsed.roles ? (
          <>
            {/* 角色一多就得靠搜：与上方的会话搜索用同一套交互与观感 */}
            <div className={styles.searchRow}>
              <label className={styles.search}>
                <IconSearch size={14} />
                <input
                  type="search"
                  value={roleQuery}
                  placeholder="搜索角色"
                  aria-label="搜索角色"
                  onChange={(event) => setRoleQuery(event.target.value)}
                />
              </label>
            </div>
            <div className={styles.list} {...rolesDrag.listProps}>
            {visibleRoles.map((role) => (
              <div
                key={role.id}
                className={styles.roleRowWrap}
                data-drag-id={role.id}
                data-dragging={rolesDrag.draggingId === role.id}
                data-over={rolesDrag.overId === role.id}
              >
                <DragHandle
                  placement="gutter"
                  {...rolesDrag.handleProps(role.id, `拖动调整「${role.name}」的顺序`)}
                />
                {/* 角色行同理：不挂悬停浮层 */}
                <button
                  type="button"
                  className={styles.roleRow}
                  data-active={activeRoleId === role.id}
                  onClick={() => openRolesPanel(role.id)}
                >
                  <Avatar avatar={role.avatar} name={role.name} size={28} />
                  <span className={styles.roleText}>
                    <span className={styles.roleName}>{role.name}</span>
                    {role.description ? (
                      <span className={styles.roleDesc}>{role.description}</span>
                    ) : null}
                  </span>
                </button>
              </div>
            ))}
            {visibleRoles.length === 0 ? (
              <p className={styles.empty}>
                {roleQuery.trim().length > 0 ? '没有匹配的角色。' : '还没有角色，点 + 新建一个。'}
              </p>
            ) : null}
            </div>
          </>
        ) : null}
      </section>

      <div className={styles.footer}>
        {/* 主题从"三颗按钮轮流点"改成下拉菜单：主题数量不再受版面限制 */}
        <div className={styles.themeSwitch} role="group" aria-label="选择主题">
          <Dropdown
            value={preference}
            onChange={(value) => setPreference(value as ThemePreference)}
            options={themeOptions.map((option) => ({ value: option.id, label: option.name }))}
          />
        </div>

        <IconButton label="全局设置 (Ctrl+,)" size={30} onClick={() => openSettings()}>
          <IconSettings size={16} />
        </IconButton>
      </div>
    </aside>
  );
}

/**
 * 相对时间
 *
 * 用"刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前"而不是绝对时间：
 * 会话列表里用户关心的是"多久以前聊的"，不是精确到分的时刻。
 */
function relativeTime(timestamp: number, now = Date.now()): string {
  const minute = 60_000;
  const diff = now - timestamp;

  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;

  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (timestamp >= startOfToday - 86_400_000) return '昨天';
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}
