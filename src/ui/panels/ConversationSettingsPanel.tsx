import { useEffect, useMemo } from 'react';
import { MAX_CONVERSATION_TITLE_LENGTH } from '@domain/entities/conversation';
import { LAYER_LABEL, resolveConfig } from '@domain/rules/resolveConfig';
import { SAMPLING_CONSTRAINTS, type SamplingField } from '@domain/value-objects/sampling';
import { estimateTokens } from '@domain/value-objects/usage';
import { WRITING_MODES, type WritingMode } from '@domain/value-objects/writingMode';
import {
  Dropdown,
  NumberField,
  Segmented,
  SettingGroup,
  SettingRow,
  Slider,
  Switch,
  TextArea,
  TextField,
  Tooltip,
} from '@ui/primitives';
import { useChatStore } from '@ui/stores/chatStore';
import { useUiStore } from '@ui/stores/uiStore';
import { DisplayToggles } from './DisplayToggles';
import { useRolesStore } from '@ui/stores/rolesStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useModalFocus } from '@ui/hooks/useModalFocus';
import { useWorkspaceStore } from '@ui/stores/workspaceStore';
import { IconClose, IconFolder } from '@ui/components/Icons';
import styles from './ConversationSettingsPanel.module.css';

/**
 * 本会话设置（右侧抽屉）
 *
 * 配置层次：**全局默认 → 角色实例（只读快照）→ 本会话覆盖**。
 * 每行右侧标注当前值来自哪一层，用户一眼能看出"我改的到底生效没有"。
 *
 * ⚠️ 这里**没有"切换角色预设"**：会话与角色是「实例 / 预制体」关系，
 * 角色在创建会话时快照一次；想换角色就新开一场对话（角色详情页底部有「开始对话」）。
 */
export function ConversationSettingsPanel() {
  const closePanel = useUiStore((s) => s.closePanel);
  const openRolesPanel = useUiStore((s) => s.openRolesPanel);
  const conversation = useChatStore((s) => s.conversation);
  const patchConversation = useChatStore((s) => s.patchConversation);
  const resyncRoleInstance = useChatStore((s) => s.resyncRoleInstance);
  const settings = useSettingsStore((s) => s.settings);
  const roles = useRolesStore((s) => s.roles);
  const workspace = useWorkspaceStore((s) => s.snapshot);
  const selectWorkspace = useWorkspaceStore((s) => s.selectDirectory);
  const clearWorkspace = useWorkspaceStore((s) => s.clearDirectory);
  const authorizeWorkspace = useWorkspaceStore((s) => s.reauthorize);
  const authorizeWrite = useWorkspaceStore((s) => s.authorizeWrite);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePanel]);

  const config = useMemo(() => resolveConfig(settings, conversation), [settings, conversation]);
  const instance = conversation.roleInstance;

  const preset = settings.writingModes[config.writingMode === 'chat' ? 'short' : config.writingMode];
  const sourceRole = instance?.roleId
    ? (roles.find((item) => item.id === instance.roleId) ?? null)
    : null;
  const instanceStale = sourceRole && instance ? sourceRole.updatedAt > instance.capturedAt : false;

  /*
   * 工作区
   *
   * 注意显示的是**目录名**：浏览器只给句柄不给路径，所以顶栏与会话设置里
   * 都只能显示名字。这一点在 help 里说明了，免得用户以为"路径没读出来"。
   */
  const workspaceNeedsGrant =
    workspace.handleState === 'prompt' || workspace.handleState === 'denied';
  const workspaceLabel = workspace.root?.label ?? '未选择';

  const setSampling = (key: SamplingField, value: number) => {
    patchConversation({ params: { ...conversation.params, [key]: value } });
  };

  const modalFocus = useModalFocus<HTMLElement>();

  return (
    <div className={styles.overlay} onClick={closePanel} role="presentation">
      <aside
        ref={modalFocus.ref}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="本会话设置"
        tabIndex={-1}
        onKeyDown={modalFocus.onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>本会话设置</h2>
            <p className={styles.subtitle}>只影响这条对话 · 每行右侧标注当前值来自哪一层</p>
          </div>
          <button type="button" className={styles.close} onClick={closePanel} aria-label="关闭">
            <IconClose size={17} />
          </button>
        </header>

        <div className={styles.body}>
          <SettingGroup title="基本">
            <SettingRow label="会话标题" stacked>
              <TextField
                full
                value={conversation.title}
                /* 超长标题会撑破侧栏与顶栏那一行：在入口就截到上限，别等界面被顶坏 */
                onChange={(value) =>
                  patchConversation({ title: value.slice(0, MAX_CONVERSATION_TITLE_LENGTH) })
                }
                placeholder="新对话"
              />
            </SettingRow>
            <SettingRow
              label="工作区目录"
              help={
                workspace.supported
                  ? '本会话可以访问的本地目录。浏览器出于安全只提供目录句柄、不提供真实路径，所以这里显示的是目录名'
                  : (workspace.unsupportedReason ?? '当前环境不支持访问本地目录')
              }
              hint={
                workspace.root === null
                  ? undefined
                  : workspaceNeedsGrant
                    ? '需要重新授权'
                    : `已列出 ${workspace.entries.length} 项`
              }
            >
              <div className={styles.inline}>
                <Tooltip
                  label={
                    workspaceNeedsGrant
                      ? '浏览器重启后，已保存的目录需要你点一下重新授权'
                      : '选择本会话的工作区目录'
                  }
                >
                  <button
                    type="button"
                    className={styles.pathBtn}
                    disabled={!workspace.supported}
                    onClick={() => void selectWorkspace()}
                  >
                    <IconFolder size={14} />
                    <span>{workspaceLabel}</span>
                  </button>
                </Tooltip>
                {workspaceNeedsGrant ? (
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => void authorizeWorkspace()}
                  >
                    重新授权
                  </button>
                ) : null}
                {workspace.root ? (
                  <Tooltip label="清除工作区并丢弃已保存的目录授权">
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => void clearWorkspace()}
                    >
                      清除
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            </SettingRow>
            <SettingRow
              label="允许编辑工作区文件"
              help="关闭时 AI 只能读取工作区文件；它一旦尝试编辑，会收到「无权限编辑文件」并向你弹出警报。开启后不再逐次询问即可写入"
              hint={
                !workspace.permission.allowEdit
                  ? workspace.permission.source === 'conversation'
                    ? '本会话禁止'
                    : '继承全局'
                  : workspace.writeState === 'granted'
                    ? workspace.permission.source === 'conversation'
                      ? '本会话覆盖'
                      : '继承全局'
                    : '缺少浏览器写入授权'
              }
            >
              <div className={styles.inline}>
                <Switch
                  label="允许编辑工作区文件"
                  checked={workspace.permission.allowEdit}
                  onChange={(value) => {
                    /*
                     * 打开开关时**先申请浏览器的写入授权**，拿到才真的打开
                     *
                     * 顺序不能反：浏览器只在用户手势里给权限，而这一次点击
                     * 正是那个手势。先开开关、事后补申请，申请会因为"没有手势"
                     * 失败 —— 用户看到的就是"界面写着已开启，实际一个字节都写不进去"。
                     */
                    if (!value) {
                      patchConversation({ allowWorkspaceEdit: false });
                      return;
                    }
                    void authorizeWrite().then((granted) => {
                      if (granted) patchConversation({ allowWorkspaceEdit: true });
                    });
                  }}
                />
                {workspace.permission.allowEdit && workspace.writeState !== 'granted' ? (
                  <Tooltip label="还没授予这个目录的写权限。浏览器只认点击动作，只能由你点一次">
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => void authorizeWrite()}
                    >
                      授权写入
                    </button>
                  </Tooltip>
                ) : null}
                {workspace.permission.source === 'conversation' ? (
                  <Tooltip label="删掉本会话的覆盖，改回跟随全局设置">
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => patchConversation({ allowWorkspaceEdit: null })}
                    >
                      改回继承
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            </SettingRow>
          </SettingGroup>

          <SettingGroup
            title="角色实例"
            help="会话在创建时把角色预设快照成一份「实例」，之后互不影响：改角色预设不会串改历史对话。想换角色请新建对话"
          >
            <SettingRow label="使用中的角色" hint={instance ? '创建时的快照' : '未使用角色'}>
              <div className={styles.inline}>
                <span className={styles.roleName}>{instance?.name ?? '无'}</span>
                {instance?.roleId ? (
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => openRolesPanel(instance.roleId)}
                  >
                    查看
                  </button>
                ) : null}
              </div>
            </SettingRow>
            {instance ? (
              <SettingRow
                label="同步角色预设"
                help="角色预设后来改过了，但你不想重开对话时可以点这里，把最新版覆盖到本会话"
                hint={instanceStale ? '预设已更新' : '已是最新'}
              >
                <Tooltip label={sourceRole ? '用最新版角色预设覆盖本会话的实例' : '来源角色已被删除'}>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    disabled={!sourceRole}
                    onClick={() => sourceRole && resyncRoleInstance(sourceRole)}
                  >
                    重新同步
                  </button>
                </Tooltip>
              </SettingRow>
            ) : null}
          </SettingGroup>

          <SettingGroup
            title="称谓"
            help="这条对话里 AI 叫什么、怎么称呼你。留空则逐层向上继承（角色实例 → 全局）"
          >
            <SettingRow
              label="AI 的名字"
              hint={conversation.assistantName ? '本会话覆盖' : LAYER_LABEL[config.sources.identity]}
            >
              <TextField
                width={180}
                value={conversation.assistantName ?? ''}
                onChange={(value) => patchConversation({ assistantName: value || null })}
                placeholder={config.identity.assistantName}
              />
            </SettingRow>
            <SettingRow
              label="对你的称呼"
              hint={conversation.userName ? '本会话覆盖' : `全局：${settings.identity.userName}`}
            >
              <TextField
                width={180}
                value={conversation.userName ?? ''}
                onChange={(value) => patchConversation({ userName: value || null })}
                placeholder={settings.identity.userName}
              />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="预设词">
            <SettingRow
              label="自定义预设词"
              help="关闭时使用角色实例里的预设词。开启后这条对话使用自己的系统提示词"
            >
              <Switch
                label="自定义预设词"
                checked={conversation.systemPrompt !== null}
                onChange={(value) =>
                  patchConversation({ systemPrompt: value ? (instance?.systemPrompt ?? '') : null })
                }
              />
            </SettingRow>
            <SettingRow
              label="系统提示词"
              stacked
              /*
               * 不设字数上限（悄悄截断用户写的指令比让它长着更糟），但要让他**看见体积**：
               * 预设词每一轮都会随请求发出去，是上下文预算里最容易被忽略的一块。
               */
              hint={
                conversation.systemPrompt === null
                  ? undefined
                  : `约 ${estimateTokens(conversation.systemPrompt)} tok · 每轮都会随请求发出`
              }
            >
              <TextArea
                rows={6}
                value={conversation.systemPrompt ?? ''}
                onChange={(value) => patchConversation({ systemPrompt: value })}
                placeholder={
                  conversation.systemPrompt === null
                    ? `继承中：${instance?.name ?? '无角色'}`
                    : '写点什么…'
                }
              />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="模型与输出">
            <SettingRow
              label="模型配置"
              help="决定用哪套端点与凭据。留空则继承角色实例 → 全局当前配置"
            >
              <Dropdown
                value={conversation.modelProfileId ?? 'inherit'}
                width={180}
                onChange={(id) => patchConversation({ modelProfileId: id === 'inherit' ? null : id })}
                options={[
                  { value: 'inherit', label: '继承（角色 / 全局）' },
                  ...settings.model.profiles.map((profile) => ({
                    value: profile.id,
                    label: profile.name || profile.model || '未命名',
                  })),
                ]}
              />
            </SettingRow>

            <SettingRow
              label="续写档位"
              help="普通 = 单次生成；短/中/长 = 自动续写直到达到字数下限"
              hint={LAYER_LABEL[config.sources.writingMode]}
            >
              <Segmented
                value={conversation.writingMode}
                onChange={(value) => patchConversation({ writingMode: value as WritingMode | 'chat' })}
                options={[
                  { value: 'chat', label: '普通' },
                  ...WRITING_MODES.map((mode) => ({
                    value: mode,
                    label: `${settings.writingModes[mode].label} ${(
                      settings.writingModes[mode].minOutputChars / 1000
                    ).toFixed(0)}k`,
                  })),
                ]}
              />
            </SettingRow>
            {config.writingMode !== 'chat' ? (
              <>
                <SettingRow
                  label="字数下限"
                  help="本次生成至少写到的字数，低于它会自动续写"
                  hint={conversation.minOutputChars === null ? `档位默认：${preset.minOutputChars.toLocaleString()}` : '本会话覆盖'}
                >
                  <NumberField
                    value={config.minOutputChars}
                    min={500}
                    max={2_000_000}
                    step={500}
                    suffix="字"
                    width={140}
                    onChange={(value) => patchConversation({ minOutputChars: value })}
                  />
                </SettingRow>
                <SettingRow
                  label="续写提示词"
                  help="每轮续写时附带的指令，防重复主要靠它。留空则用全局档位预设里的写法"
                  stacked
                >
                  <TextArea
                    rows={2}
                    value={conversation.continuationPrompt ?? ''}
                    onChange={(value) => patchConversation({ continuationPrompt: value || null })}
                    placeholder={`全局默认：${settings.continuationPrompt}`}
                  />
                </SettingRow>
              </>
            ) : null}
            <SettingRow
              label="保留最近原文"
              help="压缩时至少保留最近多少轮的完整原文。写小说可以设大一些（保住近处的情节与语气），问代码设小一些更省上下文。留空 = 继承全局"
              hint={LAYER_LABEL[config.sources.keepRecentTurns]}
            >
              <div className={styles.inline}>
                <Switch
                  label="自定义保留轮数"
                  checked={conversation.keepRecentMessages !== null}
                  onChange={(value) =>
                    patchConversation({
                      keepRecentMessages: value ? settings.context.keepRecentMessages : null,
                    })
                  }
                />
                <NumberField
                  value={config.keepRecentTurns}
                  min={1}
                  max={200}
                  step={1}
                  width={130}
                  suffix="轮"
                  onChange={(value) => patchConversation({ keepRecentMessages: value })}
                />
              </div>
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="采样参数（本会话）" help="未改动的字段继续使用上一层，不会被「冻结」">
            {(['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'] as const).map((key) => {
              const constraint = SAMPLING_CONSTRAINTS[key];
              return (
                <SettingRow
                  key={key}
                  label={constraint.label}
                  help={constraint.hint}
                  hint={conversation.params[key] === undefined ? '继承中' : '本会话覆盖'}
                >
                  <Slider
                    value={conversation.params[key] ?? settings.sampling[key] ?? 0}
                    min={constraint.min}
                    max={constraint.max}
                    step={constraint.step}
                    onChange={(next) => setSampling(key, next)}
                    format={(v) => v.toFixed(2)}
                    width={170}
                  />
                </SettingRow>
              );
            })}
            <SettingRow
              label="单次最大输出"
              help={SAMPLING_CONSTRAINTS.maxTokens.hint}
              hint={conversation.params.maxTokens === undefined ? '继承中' : '本会话覆盖'}
            >
              <NumberField
                value={conversation.params.maxTokens ?? settings.sampling.maxTokens ?? 8192}
                min={256}
                max={65536}
                step={256}
                width={130}
                suffix="tok"
                onChange={(value) => setSampling('maxTokens', value)}
              />
            </SettingRow>
          </SettingGroup>

          {/* 调试参数时就在对话旁边，不必再翻一层全局设置 */}
          <DisplayToggles />

          <div className={styles.footer}>
            <Tooltip label="清空本会话的所有覆盖，回到角色实例 / 全局设置">
              <button
                type="button"
                className={styles.resetBtn}
                onClick={() => {
                  /*
                   * 清空的是**本会话的全部覆盖**（预设词、模型、采样参数、称谓…），
                   * 一击即生效 —— 所以留一份原值换一条带"撤销"的通知，别弹确认框。
                   */
                  const previous = {
                    systemPrompt: conversation.systemPrompt,
                    model: conversation.model,
                    params: conversation.params,
                    keepRecentMessages: conversation.keepRecentMessages,
                    writingMode: conversation.writingMode,
                    minOutputChars: conversation.minOutputChars,
                    continuationPrompt: conversation.continuationPrompt,
                    assistantName: conversation.assistantName,
                    userName: conversation.userName,
                    allowWorkspaceEdit: conversation.allowWorkspaceEdit,
                  };
                  patchConversation({
                    systemPrompt: null,
                    model: null,
                    params: {},
                    keepRecentMessages: null,
                    writingMode: 'chat',
                    minOutputChars: null,
                    continuationPrompt: null,
                    assistantName: null,
                    userName: null,
                    // 工作区目录本身不是"覆盖"，所以不清除；只把编辑权限交回全局
                    allowWorkspaceEdit: null,
                  });
                  useUiStore.getState().pushNotice({
                    tone: 'alert',
                    message: '已把本会话的覆盖全部恢复为继承',
                    action: { label: '撤销', run: () => patchConversation(previous) },
                  });
                }}
              >
                全部恢复为继承
              </button>
            </Tooltip>
          </div>
        </div>
      </aside>
    </div>
  );
}
