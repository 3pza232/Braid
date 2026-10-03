import { useEffect, useMemo, useState } from 'react';
import { MAX_ROLE_NAME_LENGTH, type RolePreset } from '@domain/entities/rolePreset';
import { matchesQuery } from '@domain/rules/fuzzyMatch';
import { findUnknownMacros } from '@domain/rules/macroResolver';
import { activeProfileOf } from '@domain/value-objects/appSettings';
import { MAX_OUTPUT_TOKENS_CEILING, SAMPLING_CONSTRAINTS } from '@domain/value-objects/sampling';
import { WRITING_MODES, type WritingMode } from '@domain/value-objects/writingMode';
import {
  DragHandle,
  Dropdown,
  IconButton,
  NumberField,
  Segmented,
  SettingGroup,
  SettingRow,
  Slider,
  TextArea,
  TextField,
  Tooltip,
} from '@ui/primitives';
import { useRolesStore } from '@ui/stores/rolesStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useModalFocus } from '@ui/hooks/useModalFocus';
import { useOverlayDismiss } from '@ui/hooks/useOverlayDismiss';
import { useUiStore } from '@ui/stores/uiStore';
import { Avatar } from '@ui/components/Avatar';
import { AvatarEditor } from '@ui/components/AvatarEditor';
import { useChatStore } from '@ui/stores/chatStore';
import {
  IconClose,
  IconCopy,
  IconPlus,
  IconSearch,
  IconSpark,
  IconTrash,
} from '@ui/components/Icons';
import { useContainer } from '@ui/BraidProvider';
import { useDragReorder } from '@ui/hooks/useDragReorder';
import styles from './RolesPanel.module.css';

/**
 * 内置变量及其默认值来源
 *
 * 它们在发送前由引擎计算，不来自角色数据 —— 但**允许被角色覆盖**
 * （resolveConfig 里角色自定义变量的优先级更高）。
 * 所以在「变量」区把它们也列出来：用户能看见、能改、改完还能一键恢复默认，
 * 而不是"内置的那几个只能用不能碰"。
 */
const BUILTIN_VARIABLES: ReadonlyArray<{ name: string; hint: string }> = [
  { name: 'user', hint: '用户名（来自全局设置或本会话覆盖）' },
  { name: 'char', hint: '助手名' },
  { name: 'writing_mode', hint: '当前输出档位' },
  { name: 'date', hint: '今天的日期，发送时替换' },
];

const MODE_OPTIONS: Array<{ value: WritingMode | 'chat' | 'inherit'; label: string }> = [
  { value: 'inherit', label: '继承' },
  { value: 'chat', label: '普通' },
  ...WRITING_MODES.map((mode) => ({ value: mode, label: mode === 'short' ? '短' : mode === 'medium' ? '中' : '长' })),
];

/**
 * 角色预设管理
 *
 * 设计立场：Braid **不预设角色倾向**，只提供编辑器与解析规则。
 * 出厂样例角色也只是普通数据，可改可删可复制；用户可以从零搓自己的。
 *
 * 编辑策略：**草稿 + 显式保存**。
 * 编辑区操作的是一份草稿，点「保存」才落库；不保存就切走，改动作数不存。
 * 这样"改一半后悔了"有出路（直接切走即可），也不会出现误触改坏角色却不自知
 * （改动即时落库的年代，动一个滑杆就改了正式角色，且没有任何"已改"的提示）。
 */
export function RolesPanel() {
  const closePanel = useUiStore((s) => s.closePanel);
  const roles = useRolesStore((s) => s.roles);
  const loaded = useRolesStore((s) => s.loaded);
  const error = useRolesStore((s) => s.error);
  const clearError = useRolesStore((s) => s.clearError);
  const create = useRolesStore((s) => s.create);
  const save = useRolesStore((s) => s.save);
  const duplicate = useRolesStore((s) => s.duplicate);
  const remove = useRolesStore((s) => s.remove);
  const importJson = useRolesStore((s) => s.importJson);
  const exportJson = useRolesStore((s) => s.exportJson);
  const reorder = useRolesStore((s) => s.reorder);

  /*
   * 拖动排序
   *
   * 这里传**全部**角色的 id（而不是筛过的那一份）：列表上方有搜索框，
   * 筛过之后仍然要让"可见两行互换"的结果与用户看到的一致 ——
   * 用全量 id 时，被过滤掉的那些待在原位不动，互换的两行位置关系不变。
   */
  const rolesDrag = useDragReorder(
    roles.map((role) => role.id),
    reorder,
  );

  const startConversationWithRole = useChatStore((s) => s.startConversationWithRole);

  const settings = useSettingsStore((s) => s.settings);
  // 顶栏点角色进来时，直接选中那个角色，而不是每次都从第一个开始
  const targetId = useUiStore((s) => s.rolesPanelTargetId);
  const [selectedId, setSelectedId] = useState<string | null>(targetId);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePanel]);

  // 选中项失效（首次加载完成 / 被删除）时回落到第一个
  const selected = useMemo(() => {
    const found = roles.find((role) => role.id === selectedId);
    return found ?? roles[0] ?? null;
  }, [roles, selectedId]);

  /*
   * 草稿：编辑区碰的是它，点「保存」才写进 store
   *
   * 同步时机是"selected 变化时"—— 也就是切换角色、或保存成功之后。
   * 这两条路径都会让草稿回到已保存版本，正好实现"没保存就作废"。
   */
  const container = useContainer();
  const [draft, setDraft] = useState<RolePreset | null>(selected);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 角色名筛选（模糊匹配，与侧栏同一套规则） */
  const [roleQuery, setRoleQuery] = useState('');
  useEffect(() => {
    setDraft(selected);
    setConfirmDelete(false);
  }, [selected]);

  /** 表单绑定的是草稿；列表高亮 / 导出 / 开始对话用的仍是**已保存**的版本 */
  const editing = draft ?? selected;
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));

  /** 按名字模糊筛选（与侧栏会话搜索同一套匹配规则） */
  const visibleRoles = useMemo(() => {
    const trimmed = roleQuery.trim();
    if (trimmed.length === 0) return roles;
    return roles.filter((role) => matchesQuery(role.name, trimmed));
  }, [roles, roleQuery]);

  const patch = (changes: Partial<RolePreset>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  };

  /**
   * 切换选中的角色
   *
   * 草稿没保存就切走，等于用户刚打的改动**无声消失** —— `selected` 一变，
   * 下面的 effect 就会把草稿重置成已保存的版本。这不是"顺手清理"，是让人白改一版。
   * 所以先把这件事摆到台面上：记下"想切到谁"，让 `dirty` 提示条变成三选一
   * （保存并切换 / 放弃并切换 / 留下继续编辑），由用户决定。
   */
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const selectRole = (id: string | null) => {
    if (dirty && id !== selected?.id) {
      setPendingSelectId(id);
      return;
    }
    setSelectedId(id);
  };

  const commitDraft = () => {
    if (draft && dirty) save(draft);
  };

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2400);
  };

  /**
   * 导出为**文件**，而不是剪贴板
   *
   * 剪贴板是"一次性的"：关掉面板、复制了别的东西，这份角色就找不回来了。
   * 角色预设是用来攒的资产，必须落成能长期保存、能发给别人的东西。
   */
  const handleExport = async () => {
    if (!selected) return;
    const json = exportJson(editing.id);
    const result = await container.fileDialog.saveText(
      `角色-${(editing.name || '未命名').replace(/[\\/:*?"<>|]/g, '_')}.json`,
      json,
    );
    if (!result.ok) {
      flash(result.error.message);
      return;
    }
    // data === false 是"用户取消了"，不该弹任何提示
    if (result.data) flash('已导出为 JSON 文件');
  };

  const handleImport = async () => {
    const picked = await container.fileDialog.openText('角色预设 JSON', ['.json']);
    if (!picked.ok) {
      flash(picked.error.message);
      return;
    }
    if (picked.data === null) return; // 用户取消
    const created = await importJson(picked.data);
    if (created) {
      // 走 selectRole 而不是直接选：导入前若有没保存的改动，不能就这么盖掉
      selectRole(created.id);
      flash('导入成功');
    }
  };

  const modalFocus = useModalFocus<HTMLElement>();
  // 点遮罩关闭：**按下与松手都要在遮罩上**（拖出去松手不算，见 useOverlayDismiss）
  const overlayDismiss = useOverlayDismiss(closePanel);

  return (
    <div className={styles.overlay} {...overlayDismiss} role="presentation">
      <section
        ref={modalFocus.ref}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="角色预设"
        tabIndex={-1}
        onKeyDown={modalFocus.onKeyDown}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>角色预设</h2>
          <span className={styles.subtitle}>角色的字段全部由你自己定义，Braid 不预设任何倾向</span>
          {notice ? <span className={styles.notice}>{notice}</span> : null}
          <button type="button" className={styles.close} onClick={closePanel} aria-label="关闭">
            <IconClose size={17} />
          </button>
        </header>

        <div className={styles.layout}>
          {/* ── 左：角色列表 ── */}
          <aside className={styles.listPane}>
            <div className={styles.listActions}>
              <button
                type="button"
                className={styles.primarySm}
                onClick={async () => {
                  const created = await create();
                  if (created) selectRole(created.id);
                }}
              >
                <IconPlus size={14} />
                新建空白角色
              </button>
              <Tooltip label="从 JSON 文件导入一个角色">
                <button type="button" className={styles.ghostSm} onClick={handleImport}>
                  导入
                </button>
              </Tooltip>
            </div>

            <div className={styles.listSearch}>
              <IconSearch size={13} />
              <input
                type="search"
                value={roleQuery}
                placeholder="搜索角色名"
                aria-label="搜索角色名"
                onChange={(event) => setRoleQuery(event.target.value)}
              />
            </div>

            <ul className={styles.list} {...rolesDrag.listProps}>
              {visibleRoles.map((role) => (
                <li
                  key={role.id}
                  className={styles.listRow}
                  data-drag-id={role.id}
                  data-dragging={rolesDrag.draggingId === role.id}
                  data-over={rolesDrag.overId === role.id}
                >
                  <DragHandle
                    placement="gutter"
                    {...rolesDrag.handleProps(role.id, `拖动调整「${role.name}」的顺序`)}
                  />
                  <button
                    type="button"
                    className={styles.listItem}
                    data-active={selected?.id === role.id}
                    onClick={() => selectRole(role.id)}
                  >
                    <Avatar avatar={role.avatar} name={role.name} size={34} />
                    <span className={styles.listText}>
                      <span className={styles.listName}>{role.name}</span>
                      <span className={styles.listDesc}>{role.description || '无描述'}</span>
                    </span>
                    {role.builtin ? <span className={styles.builtinTag}>样例</span> : null}
                  </button>
                </li>
              ))}
              {loaded && roles.length === 0 ? (
                <li className={styles.empty}>还没有任何角色，点上方新建一个。</li>
              ) : null}
              {/*
                有角色、但全被筛选条件滤掉了 —— 必须说一句
                否则用户看到的是"列表突然空了"，第一反应是角色丢了。
              */}
              {loaded && roles.length > 0 && visibleRoles.length === 0 ? (
                <li className={styles.empty}>没有名字匹配「{roleQuery.trim()}」的角色。</li>
              ) : null}
            </ul>
          </aside>

          {/* ── 右：编辑器 ── */}
          <div className={styles.editorPane}>
            {error ? (
              <p className={styles.error} onClick={clearError}>
                {error}（点击关闭）
              </p>
            ) : null}

            {!editing ? (
              <p className={styles.empty}>选择或新建一个角色开始编辑。</p>
            ) : (
              <>
              {/*
                只让表单区滚动，底部操作条留在滚动区**之外**。
                刻意不用 `position: sticky`：那样内容会从按钮底下穿过去，
                虽然滚到底不会被挡，但滚动过程中一直在"被压住"。
                现在滚动区就到按钮上边缘为止，不存在遮挡。
              */}
              {/*
                未保存时想切走：把选择权交回用户，而不是把他的改动丢掉
                （触发点见 `selectRole`）
              */}
              {pendingSelectId !== null ? (
                <div className={styles.unsavedSwitch} role="alert">
                  <span className={styles.unsavedText}>这个角色有未保存的修改，切换会丢弃它们。</span>
                  <button
                    type="button"
                    className={styles.ghostSm}
                    onClick={() => setPendingSelectId(null)}
                  >
                    留下继续编辑
                  </button>
                  <button
                    type="button"
                    className={styles.ghostSm}
                    onClick={() => {
                      setDraft(selected);
                      setSelectedId(pendingSelectId);
                      setPendingSelectId(null);
                    }}
                  >
                    放弃修改并切换
                  </button>
                  <button
                    type="button"
                    className={styles.primarySm}
                    onClick={() => {
                      commitDraft();
                      setSelectedId(pendingSelectId);
                      setPendingSelectId(null);
                    }}
                  >
                    保存并切换
                  </button>
                </div>
              ) : null}

              <div className={styles.formScroll}>
              <div className={styles.form}>
                <SettingGroup title="基本信息">
                  <SettingRow label="名称">
                    <TextField
                      width={260}
                      value={editing.name}
                      /* 名字在侧栏与列表里只占一行：超长会在入口就截到上限 */
                      onChange={(value) => patch({ name: value.slice(0, MAX_ROLE_NAME_LENGTH) })}
                      placeholder="例如：我的写作搭子"
                    />
                  </SettingRow>
                  <SettingRow label="描述" help="只用于列表里区分，不影响发给模型的内容">
                    <TextField
                      width={320}
                      value={editing.description}
                      onChange={(value) => patch({ description: value })}
                      placeholder="一句话说明这个角色干什么"
                    />
                  </SettingRow>
                  <SettingRow
                    label="头像"
                    help="图片优先；没有图片就用 emoji；再没有就用名称首字；都没有就只显示底色"
                  >
                    <AvatarEditor
                      value={editing.avatar}
                      onChange={(next) => patch({ avatar: next })}
                      name={editing.name}
                    />
                  </SettingRow>
                  <SettingRow label="标签" help="用逗号分隔，仅用于你自己检索">
                    <TextField
                      width={260}
                      value={editing.tags.join(', ')}
                      onChange={(value) =>
                        patch({ tags: value.split(',').map((t) => t.trim()).filter(Boolean) })
                      }
                      placeholder="写作, 长篇"
                    />
                  </SettingRow>
                </SettingGroup>

                <SettingGroup
                  title="称谓"
                  help="决定这个角色如何称呼你、以及它自称什么。留空则继承全局身份设置"
                >
                  <SettingRow label="AI 的名字" hint={editing.assistantName ? '已覆盖' : `继承：${settings.identity.assistantName}`}>
                    <TextField
                      width={220}
                      value={editing.assistantName ?? ''}
                      onChange={(value) => patch({ assistantName: value || null })}
                      placeholder="留空 = 继承全局"
                    />
                  </SettingRow>
                  <SettingRow label="对你的称呼" hint={editing.userName ? '已覆盖' : `继承：${settings.identity.userName}`}>
                    <TextField
                      width={220}
                      value={editing.userName ?? ''}
                      onChange={(value) => patch({ userName: value || null })}
                      placeholder="留空 = 继承全局"
                    />
                  </SettingRow>
                </SettingGroup>

                <SettingGroup
                  title="系统提示词"
                  help="角色的核心；支持 {{user}} {{char}} 等变量"
                >
                  <SettingRow label="预设词" stacked>
                    <TextArea
                      rows={9}
                      value={editing.systemPrompt}
                      onChange={(value) => patch({ systemPrompt: value })}
                      placeholder={'你是一位…\n\n规则：\n1. …'}
                    />
                  </SettingRow>
                  <SettingRow
                    label="插入变量"
                    help="选一个变量名，把 {{名字}} 追加到预设词末尾。变量一多，下拉比一排按钮好找得多"
                  >
                    {/*
                      用下拉而不是一排按钮：变量一多（内置 4 个 + 用户自定义若干个），
                      横排会换行、挤满面板，而且每加一个变量按钮就更长一排。
                      下拉的选项永远只占一行，且选项选完不改变显示 —— 可以连着插好几个。
                    */}
                    <Dropdown<string>
                      value=""
                      width={230}
                      placeholder="选择要插入的变量…"
                      options={[
                        ...BUILTIN_VARIABLES.map((item) => ({
                          value: `{{${item.name}}}`,
                          label: `{{${item.name}}} · 内置`,
                        })),
                        ...Object.keys(editing.variables)
                          .filter((name) => !BUILTIN_VARIABLES.some((item) => item.name === name))
                          .map((name) => ({ value: `{{${name}}}`, label: `{{${name}}} · 自定义` })),
                      ]}
                      onChange={(token) => {
                        /*
                         * 追加到末尾而不是插入光标处：预设词用的是受控 TextArea，
                         * 拿不到光标位置；而"写提示词时往末尾补一句"正是最常见的用法。
                         */
                        const base = editing.systemPrompt;
                        const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n';
                        patch({ systemPrompt: `${base}${separator}${token}` });
                      }}
                    />
                  </SettingRow>
                  <MacroWarning
                    text={editing.systemPrompt}
                    custom={Object.keys(editing.variables)}
                  />
                  <SettingRow label="开场白" help="新建会话时预填的第一条 AI 消息；留空则不预填">
                    <TextField
                      full
                      value={editing.greeting}
                      onChange={(value) => patch({ greeting: value })}
                      placeholder="留空 = 不预填"
                    />
                  </SettingRow>
                </SettingGroup>

                <SettingGroup title="模型与参数">
                  <SettingRow
                    label="模型名"
                    help="原样作为请求的 model 字段；留空 = 继承全局"
                    hint={editing.model ? '已覆盖' : `继承：${(activeProfileOf(settings)?.model ?? '') || '未设置'}`}
                  >
                    <TextField
                      mono
                      width={240}
                      value={editing.model ?? ''}
                      onChange={(value) => patch({ model: value || null })}
                      placeholder="留空 = 继承；例如 deepseek-v4-flash"
                    />
                  </SettingRow>
                  <SettingRow
                    label={SAMPLING_CONSTRAINTS.temperature.label}
                    help={SAMPLING_CONSTRAINTS.temperature.hint}
                    hint={editing.params.temperature === undefined ? '继承中' : '已覆盖'}
                  >
                    <Slider
                      value={editing.params.temperature ?? settings.sampling.temperature ?? 1}
                      min={0}
                      max={2}
                      step={0.05}
                      onChange={(value) =>
                        patch({ params: { ...editing.params, temperature: value } })
                      }
                      format={(v) => v.toFixed(2)}
                    />
                  </SettingRow>
                  {/* 标签取自同一处定义（sampling.ts），别在这里写死 —— 改名漏过一次 */}
                  <SettingRow
                    label={SAMPLING_CONSTRAINTS.maxTokens.label}
                    help={SAMPLING_CONSTRAINTS.maxTokens.hint}
                  >
                    <NumberField
                      value={editing.params.maxTokens ?? settings.sampling.maxTokens ?? 8192}
                      min={256}
                      max={MAX_OUTPUT_TOKENS_CEILING}
                      step={256}
                      suffix="tok"
                      width={140}
                      onChange={(value) => patch({ params: { ...editing.params, maxTokens: value } })}
                    />
                  </SettingRow>
                  <SettingRow label="默认输出档位" help="新建会话绑定该角色时使用的档位；留空则继承全局默认">
                    <Segmented
                      value={editing.writingMode ?? 'inherit'}
                      onChange={(value) =>
                        patch({ writingMode: value === 'inherit' ? null : (value as WritingMode | 'chat') })
                      }
                      options={MODE_OPTIONS}
                    />
                  </SettingRow>
                </SettingGroup>

                <SettingGroup
                  title="变量"
                  help="在预设词里用 {{键名}} 引用；填值即覆盖，清空回到默认"
                >
                  {/*
                    内置变量也列出来，而且**可改可清空**
                    它们本身由引擎计算，但角色的自定义变量优先级更高 ——
                    所以"想固定一个 {{user}} 名字"这件事，在这里填一次就行，
                    不必去改全局设置。清空即取消覆盖（而不是把变量变成空串）。
                  */}
                  {BUILTIN_VARIABLES.map((item) => {
                    const override = editing.variables[item.name];
                    return (
                      <SettingRow key={item.name} label={`{{${item.name}}}`} hint={item.hint}>
                        <div className={styles.inline}>
                          <TextField
                            width={260}
                            value={override ?? ''}
                            onChange={(next) => {
                              const variables = { ...editing.variables };
                              if (next.trim() === '') delete variables[item.name];
                              else variables[item.name] = next;
                              patch({ variables });
                            }}
                          />
                          {override !== undefined ? (
                            <IconButton
                              label={`恢复 {{${item.name}}} 的默认值`}
                              size={26}
                              onClick={() => {
                                const variables = { ...editing.variables };
                                delete variables[item.name];
                                patch({ variables });
                              }}
                            >
                              <IconClose size={14} />
                            </IconButton>
                          ) : null}
                        </div>
                      </SettingRow>
                    );
                  })}

                  {Object.entries(editing.variables)
                    .filter(([key]) => !BUILTIN_VARIABLES.some((item) => item.name === key))
                    .map(([key, value]) => (
                      <SettingRow key={key} label={key}>
                        <div className={styles.inline}>
                          <TextField
                            width={260}
                            value={value}
                            onChange={(next) =>
                              patch({ variables: { ...editing.variables, [key]: next } })
                            }
                          />
                          <IconButton
                            label={`删除变量 ${key}`}
                            size={26}
                            onClick={() => {
                              const next = { ...editing.variables };
                              delete next[key];
                              patch({ variables: next });
                            }}
                          >
                            <IconTrash size={14} />
                          </IconButton>
                        </div>
                      </SettingRow>
                    ))}

                  <SettingRow label="新增变量" help="例如 键名 worldview、值 低魔设定">
                    <VariableAdder
                      onAdd={(key, value) =>
                        patch({ variables: { ...editing.variables, [key]: value } })
                      }
                    />
                  </SettingRow>
                </SettingGroup>
              </div>
              </div>

              <div className={styles.footer}>
                  <Tooltip label="复制一份，名字加「副本」">
                    <button
                      type="button"
                      className={styles.ghostSm}
                      onClick={async () => {
                        const clone = await duplicate(editing.id);
                        if (clone) selectRole(clone.id);
                      }}
                    >
                      <IconCopy size={14} />
                      复制
                    </button>
                  </Tooltip>
                  <Tooltip label="导出为 JSON 并复制到剪贴板，不含密钥">
                    <button type="button" className={styles.ghostSm} onClick={handleExport}>
                      导出
                    </button>
                  </Tooltip>

                  <div className={styles.footerRight}>
                    {/*
                      保存 / 取消**只在真的改了东西时出现**
                      常驻一个灰着的「保存修改」会让人怀疑"我是不是已经改了什么"；
                      而"改完能反悔"必须有明确出口，所以取消与它成对出现。
                    */}
                    {dirty ? (
                      <>
                        <button
                          type="button"
                          className={styles.ghostSm}
                          onClick={() => setDraft(selected)}
                        >
                          取消修改
                        </button>
                        <Tooltip label="把编辑区的草稿写入角色">
                          <button type="button" className={styles.primarySm} onClick={commitDraft}>
                            保存修改
                          </button>
                        </Tooltip>
                      </>
                    ) : null}

                    {/*
                      删除确认做成**浮层**，而不是就地换掉按钮
                      就地替换会把这一行的宽度撑来撑去，把旁边几个按钮挤得乱跳；
                      浮层还能把"删的是哪一个"写清楚 —— 同名角色多的时候，
                      光问一句"确认吗"根本不足以让人确认。
                    */}
                    <div className={styles.confirmWrap}>
                      <Tooltip label="删除后不可恢复；已经在使用该角色的对话不受影响">
                        <button
                          type="button"
                          className={styles.dangerSm}
                          onClick={() => setConfirmDelete(true)}
                        >
                          <IconTrash size={14} />
                          删除此角色
                        </button>
                      </Tooltip>
                      {confirmDelete ? (
                        <div className={styles.confirmPop} role="dialog" aria-label="确认删除角色">
                          <p className={styles.confirmTitle}>删除「{editing.name || '未命名'}」？</p>
                          <p className={styles.confirmNote}>
                            删除后不可恢复。已经用过它的对话不受影响。
                          </p>
                          <div className={styles.confirmActions}>
                            <button
                              type="button"
                              className={styles.ghostSm}
                              onClick={() => setConfirmDelete(false)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className={styles.dangerSm}
                              onClick={() => {
                                remove(editing.id);
                                setConfirmDelete(false);
                                setSelectedId(null);
                              }}
                            >
                              <IconTrash size={14} />
                              删除
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <Tooltip label="用这个角色开新对话；之后改这里不影响它">
                      <button
                        type="button"
                        className={styles.primarySm}
                        onClick={() => {
                          startConversationWithRole(selected);
                          closePanel();
                        }}
                      >
                        <IconSpark size={14} />
                        开始对话
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * 未定义变量提示
 *
 * 宏替换会把**未知变量原样保留**（而不是替换成空串），因为后者会让
 * "写错一个字母"变成"模型表现莫名变差"，几乎无从排查。
 * 但保留的前提是用户能看到它 —— 这个提示就是那个"看到"。
 */
function MacroWarning({ text, custom }: { text: string; custom: string[] }) {
  const known = ['user', 'char', 'writing_mode', 'date', 'time', 'summary', ...custom];
  const unknown = findUnknownMacros(text, Object.fromEntries(known.map((name) => [name, ''])));
  if (unknown.length === 0) return null;

  return (
    <p className={styles.macroWarning}>
      未定义的变量：
      {unknown.map((name) => `{{${name}}}`).join('、')}
      。它们会被原样发送出去（模型看到的还是花括号），请在下方的「变量」里定义，或改用上面列出的内置变量。
    </p>
  );
}

/** 新增变量的两格输入（避免为了一个键值对再加一层弹窗） */
function VariableAdder({ onAdd }: { onAdd: (key: string, value: string) => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const commit = () => {
    const k = key.trim();
    if (!k) return;
    onAdd(k, value);
    setKey('');
    setValue('');
  };

  return (
    <div className={styles.inline}>
      <TextField width={120} value={key} onChange={setKey} placeholder="键名" />
      <TextField width={200} value={value} onChange={setValue} placeholder="值" />
      <button type="button" className={styles.ghostSm} onClick={commit}>
        添加
      </button>
    </div>
  );
}
