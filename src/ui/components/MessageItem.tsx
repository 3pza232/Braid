import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageNode, MessageSegment, ToolCall } from '@domain/entities/message';
import { messageText } from '@domain/entities/message';
import { Markdown } from './Markdown';
import type {
  AppearanceSettings,
  MessageDisplaySettings,
  MetaFieldId,
} from '@domain/value-objects/appSettings';
import type { ResolvedIdentity } from '@domain/rules/resolveConfig';
import { cacheStatsOf, formatCacheHitRate, type CacheStats } from '@domain/value-objects/usage';
import { IconButton, Tooltip } from '@ui/primitives';
import type { MessageId } from '@shared/ids';
import { Avatar } from './Avatar';
import { IconChevron, IconClose, IconCopy, IconPencil, IconRefresh, IconTrash } from './Icons';
import type { EditSubmitMode } from '@ports/ChatApi';
import styles from './MessageItem.module.css';

interface MessageItemProps {
  node: MessageNode;
  display: MessageDisplaySettings;
  appearance: AppearanceSettings;
  identity: ResolvedIdentity;
  /*
   * 变体位置拆成**两个数字**而不是一个对象
   *
   * 对象每次渲染都是新引用，会让 React.memo 永远判定"变了"——
   * 流式生成时每秒 8 次的父组件刷新就会把每一条消息全部重渲染一遍。
   */
  variantPosition: number;
  variantTotal: number;
  /**
   * 当前搜索命中落在**这一条的思考过程里**（正文里没有该词）
   *
   * 折叠状态下那段文字根本不在 DOM 里，跳过去了也是"什么都看不到"，
   * 所以要自动展开。传布尔值而不是整个定位对象，是为了让其余消息的
   * props 保持不变 —— memo 因此只需要重渲染真正相关的那一条。
   */
  autoExpandReasoning?: boolean;
  onEdit: (id: MessageId, text: string, mode: EditSubmitMode) => void;
  onDelete: (id: MessageId) => void;
  onRegenerate: (id: MessageId) => void;
  /** 接着往下写（「每轮询问」档位） */
  onContinue: (id: MessageId) => void;
  /**
   * 这一条正**等着用户点头**才继续写
   *
   * 只有「每轮询问」档位会产生它。做成一个必须显式传进来的布尔而不是让组件
   * 自己去读快照：否则每条消息都要订阅一次聊天快照，`memo` 也就白做了。
   */
  canContinue?: boolean;
  onSelectVariant: (id: MessageId, delta: number) => void;
  onCopy: (text: string) => void;
}

/** 结果提示的截断长度：一次目录列表或文件内容可能上万字，塞进悬浮窗根本没法看 */
const TOOL_RESULT_TIP_MAX = 600;

/**
 * 一行里怎么概括一次工具调用
 *
 * 优先取 `path`：写文件时用户最需要看到的是**它要动哪个文件**，
 * 而不是参数 JSON 里的其它字段。读不到 path 才回退到原始 JSON。
 */
function toolArgSummary(call: ToolCall): string {
  const parsed = call.parsed;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const path = (parsed as { path?: unknown }).path;
    if (typeof path === 'string' && path.length > 0) return path;
  }
  const raw = call.argumentsJson.trim();
  if (raw.length === 0) return '';
  return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 缓存命中率的说明文案
 *
 * 刻意把"服务端上报"与"本地估算"写成完全不同的两句话：
 * 把一个估算值说成服务端数据，比不给这个数字更糟 ——
 * 用户会拿它去判断成本，而估算在长会话里可能偏差很大。
 */
function cacheTip(stats: CacheStats): string {
  const hit = stats.hitTokens.toLocaleString();
  const miss = stats.missTokens.toLocaleString();

  if (stats.source === 'provider') {
    // 只给两个数：命中/未命中。多出来的解释在文档里，不塞进悬浮窗
    return `命中 ${hit} · 未命中 ${miss} token`;
  }
  // 估算值必须一眼能看出"这不是服务端数据"，但也不必写一篇说明
  return `估算：与上次相同的前缀约 ${hit} token（服务端未返回缓存数据）`;
}

/**
 * 单条消息
 *
 * 结构：
 *   AI：  [头像] [名字 + 变体切换]
 *                [气泡] [操作条]          ← 操作条在气泡右侧
 *   用户：镜像，[操作条] [气泡] [头像]      ← 操作条在气泡左侧（你要求的位置）
 *
 * 操作条默认**折叠为 0 宽**，悬停时才展开，因此不会挤占正常阅读的空间；
 * 展开时因为整行是靠气泡侧对齐的，气泡本身不会被推动。
 */
function MessageItemView({
  node,
  display,
  appearance,
  identity,
  variantPosition,
  variantTotal,
  autoExpandReasoning = false,
  onEdit,
  onDelete,
  onRegenerate,
  onSelectVariant,
  onCopy,
  onContinue,
  canContinue = false,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = messageText(node);

  /*
   * 思考过程（reasoning 段）
   *
   * 初始展开/收起取自设置，但用户点过之后就尊重用户的选择（本地覆盖）。
   * 不这样做的话，流式生成期间每次 emit 都会把用户的收起动作重置回设置值。
   */
  /*
   * 思考文本取**全部** reasoning 段拼接，而不是只取第一段
   *
   * 一次调用工具的回复里，每一轮都有自己的思考段（工具前想一次、拿到结果再想一次）。
   * 只取第一段会把后面几轮的推理全丢掉，用户会觉得"它怎么突然就动手了"。
   */
  const reasoningText = node.segments
    .filter((segment): segment is Extract<MessageSegment, { kind: 'reasoning' }> => segment.kind === 'reasoning')
    .map((segment) => segment.text)
    .join('\n\n');
  const [reasoningOverride, setReasoningOverride] = useState<boolean | null>(null);

  /*
   * 工具活动
   *
   * 把 tool_call 与对应的 tool_result 配成对。**没配到结果的也要显示** ——
   * 那意味着"正在执行"或"被中止"，而写文件是不可撤销的动作，
   * 用户有权在它落地之前就看到它打算动哪个文件。
   */
  const toolActivity: Array<{
    call: ToolCall;
    result: Extract<MessageSegment, { kind: 'tool_result' }> | null;
  }> = [];
  {
    const resultByCallId = new Map<string, Extract<MessageSegment, { kind: 'tool_result' }>>();
    for (const segment of node.segments) {
      if (segment.kind === 'tool_call') toolActivity.push({ call: segment.call, result: null });
      else if (segment.kind === 'tool_result') resultByCallId.set(segment.callId, segment);
    }
    // 结果段一定排在调用段之后，所以配对要等遍历完再做
    for (const item of toolActivity) item.result = resultByCallId.get(item.call.id) ?? null;
  }

  /*
   * 折叠时机与思考过程同一套逻辑：
   *  - 有调用在跑 → 默认展开（用户正需要看它在动什么）；
   *  - 全部结束 → 默认收起（结论已经在正文里，过程不必一直占着版面）；
   *  - 用户点过就以用户为准，否则流式更新会把他的选择冲掉。
   */
  const [toolsOverride, setToolsOverride] = useState<boolean | null>(null);
  const toolsBusy = toolActivity.some((item) => item.result === null);
  const toolsOpen = toolsOverride ?? toolsBusy;
  const toolsDone = toolActivity.filter((item) => item.result !== null).length;
  const toolsFailed = toolActivity.filter((item) => item.result?.isError === true).length;

  /*
   * 思考过程的展开时机
   *
   *  - 设置了「默认展开」→ 一直展开，**不自动折叠**（用户明确说了要一直看着）；
   *  - 默认 → **思考时展开、一出正文就自动折叠**：
   *      · 思考中（还在流式、正文还是空的）展开展示推理链路；
   *      · 正文一出现就折叠，把版面让给正文 —— 这时思考内容已经看过了。
   *
   * 用户手动点过之后以用户的为准（`reasoningOverride`），
   * 否则流式每次 emit 都会把他的操作重置回去。
   */
  const autoReasoningOpen =
    display.reasoningDefaultExpanded || (node.status === 'streaming' && text.length === 0);
  const reasoningOpen = reasoningOverride ?? autoReasoningOpen;

  /*
   * 搜索命中落在思考过程里 → 自动展开
   *
   * 依赖是布尔值而不是对象：同一条消息在用户手动收起之后，这个值不变、
   * effect 就不再跑，他的选择会被保留（否则每次重渲染都给他掰回去）。
   */
  useEffect(() => {
    if (autoExpandReasoning) setReasoningOverride(true);
  }, [autoExpandReasoning]);

  /*
   * 思考面板**自己的**跟随滚动
   *
   * 这个面板有独立的 max-height 与滚动条。外层消息区观察的是"内容总高度"，
   * 而面板一旦到达限高就**不再长高** —— 外层的跟随逻辑再也收不到变化，
   * 新吐出来的思考内容全被挤在面板内部的滚动条底下，
   * 看起来就是"跟随只在没到限高之前有效"。
   * 内层滚动容器必须有自己的跟随，这是它自己的责任。
   */
  const reasoningRef = useRef<HTMLDivElement>(null);
  const reasoningStickRef = useRef(true);
  const reasoningPinnedRef = useRef(-1);

  const onReasoningScroll = () => {
    const el = reasoningRef.current;
    if (!el) return;
    // 位置正是我们上次设的那个 → 这是我们自己滚出来的回声，不是用户操作
    if (Math.abs(el.scrollTop - reasoningPinnedRef.current) < 1) return;
    reasoningStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  useEffect(() => {
    if (!reasoningOpen) {
      // 收起时复位：下次展开应重新从底部跟起，而不是沿用上次"用户翻过"的状态
      reasoningStickRef.current = true;
      return;
    }
    /*
     * 搜索正聚焦在这一条上时不跟随
     *
     * 两个特性会直接打架：面板默认"跟着新内容滚到底"，而搜索要"停在我命中的那一句"。
     * 不挡住的话，命中在思考过程里的下一次流式输出就会把刚对齐好的位置顶走 ——
     * 表现就是"跳过去看了一眼，又自己滑跑了"。
     */
    if (autoExpandReasoning) return;

    const el = reasoningRef.current;
    if (!el || !reasoningStickRef.current) return;
    el.scrollTop = el.scrollHeight;
    // 读回**钳过的真实值**：echo 比对必须用它（理由同 MessageList 里的 pinToBottom）
    reasoningPinnedRef.current = el.scrollTop;
  }, [reasoningText, reasoningOpen, autoExpandReasoning]);

  /**
   * 已发出请求但一个字都还没回来 —— 给个明确的等待态，而不是一个空气泡
   *
   * 工具已经开始动的时候**不算等待**：那时用户该看到的是"它在动我的文件"，
   * 跳动的省略号会让人以为它在发呆。
   */
  const isWaiting = node.status === 'streaming' && text.length === 0 && toolActivity.length === 0;

  /*
   * 进入编辑态时初始化一次，**依赖里不能有 `text`**
   *
   * 正在流式的消息每 120ms 会把 text 刷新一遍，若依赖它，这个 effect 就会跟着重跑：
   * 每次都 setDraft(text) 把用户刚敲的内容覆盖掉，光标还会被重置到末尾 ——
   * 表现就是"编辑框里的字打着打着自己没了"。只在进入编辑态那一刻取一次初值即可。
   */
  useEffect(() => {
    if (!editing) return;
    setDraft(text);
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = `${Math.min(520, Math.max(150, el.scrollHeight))}px`;
  }, [editing]);


  const submit = (mode: EditSubmitMode) => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== text) onEdit(node.id, next, mode);
  };

  const isUser = node.role === 'user';
  const roleName = isUser
    ? identity.userName
    : node.role === 'assistant'
      ? identity.assistantName
      : node.role === 'system'
        ? '系统'
        : '工具';
  const avatar = isUser ? identity.userAvatar : identity.assistantAvatar;

  /**
   * 信息栏内容
   *
   * **顺序完全由设置里的数组决定**，而不是写死渲染次序 ——
   * 所以这里按 display.metaFields 遍历，命中哪个字段就产出哪一项。
   */
  const cacheStats = node.usage ? cacheStatsOf(node.usage) : null;

  const metaEntries: Array<{ id: MetaFieldId; content: ReactNode }> = [];

  for (const field of display.metaFields) {
    if (!field.enabled) continue;

    switch (field.id) {
      case 'model':
        if (node.modelRef) {
          metaEntries.push({
            id: field.id,
            content: <Tooltip label="生成这条消息时使用的模型">{node.modelRef}</Tooltip>,
          });
        }
        break;

      case 'temperature':
        if (node.paramsSnapshot?.temperature !== undefined) {
          metaEntries.push({
            id: field.id,
            content: (
              <Tooltip label="生成时的采样温度快照。改设置不会改变历史消息">
                <span className={styles.nf} aria-hidden="true">
                  󰈸
                </span>{' '}
                {node.paramsSnapshot.temperature}
              </Tooltip>
            ),
          });
        }
        break;

      case 'tokens':
        if (node.usage) {
          metaEntries.push({
            id: field.id,
            content: (
              <Tooltip
                label={`输入 ${node.usage.promptTokens} · 输出 ${node.usage.completionTokens}${
                  node.usage.reasoningTokens ? ` · 思考 ${node.usage.reasoningTokens}` : ''
                }`}
              >
                {node.usage.totalTokens.toLocaleString()} tokens
              </Tooltip>
            ),
          });
        }
        break;

      case 'cache':
        if (cacheStats) {
          metaEntries.push({
            id: field.id,
            content: (
              <Tooltip label={cacheTip(cacheStats)}>
                <span className={styles.cacheRate} data-estimated={cacheStats.source === 'estimated'}>
                  {/* 只留下数字：这一行里出现的东西已经够多了，字段名靠图标与位置区分 */}
                  {cacheStats.source === 'provider' ? '' : '≈'}
                  {formatCacheHitRate(cacheStats)}
                </span>
              </Tooltip>
            ),
          });
        }
        break;

      case 'time':
        metaEntries.push({
          id: field.id,
          content: <Tooltip label="消息创建时间">{formatTime(node.createdAt)}</Tooltip>,
        });
        break;

    }
  }

  const actions = !editing ? (
    <div className={styles.actions}>
      <Tooltip label="复制内容">
        <IconButton label="复制内容" size={26} onClick={() => onCopy(text)}>
          <IconCopy size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label="编辑">
        <IconButton label="编辑" size={26} onClick={() => setEditing(true)}>
          <IconPencil size={14} />
        </IconButton>
      </Tooltip>
      {node.role === 'assistant' ? (
        <Tooltip label="重新生成">
          <IconButton label="重新生成" size={26} onClick={() => onRegenerate(node.id)}>
            <IconRefresh size={14} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip label="删除此条消息">
        {/* 危险色：这一排里只有它是不可撤销的，必须一眼可辨（见 module.css 的 .danger） */}
        <IconButton label="删除" size={26} className={styles.danger} onClick={() => onDelete(node.id)}>
          <IconTrash size={14} />
        </IconButton>
      </Tooltip>
    </div>
  ) : null;

  return (
    <article
      className={styles.message}
      /* 供搜索定位用：正文搜索命中后要能把这一条滚进视野 */
      data-message-id={node.id}
      data-role={node.role}
      /*
       * 流式期间**不播报**，写完才播报
       *
       * 正文每 120ms 就变一次，`aria-live` 一直开着会让读屏软件念个不停，
       * 用户根本插不上话。`aria-busy` 表达"这条还在长"，写完由 polite 播报一次。
       */
      aria-busy={node.status === 'streaming'}
      aria-live={node.status === 'streaming' ? 'off' : 'polite'}
      data-editing={editing}
      data-always={display.actionBarTrigger === 'always'}
      data-avatars={appearance.showAvatars}
      data-bubble={appearance.bubbleStyle}
      data-status={node.status}
    >
      <div className={styles.avatarSlot}>
        <Avatar
          avatar={avatar}
          name={roleName}
          size={34}
          tone={isUser ? 'user' : node.role === 'system' ? 'system' : 'default'}
        />
      </div>

      <div className={styles.head}>
        <span className={styles.name}>{roleName}</span>
        {variantTotal > 1 ? (
          <span className={styles.variants}>
            <IconButton label="上一个版本" size={20} onClick={() => onSelectVariant(node.id, -1)}>
              <span className={styles.flip}>
                <IconChevron size={12} />
              </span>
            </IconButton>
            <span className={styles.variantLabel}>
              {variantPosition + 1}/{variantTotal}
            </span>
            <IconButton label="下一个版本" size={20} onClick={() => onSelectVariant(node.id, 1)}>
              <IconChevron size={12} />
            </IconButton>
          </span>
        ) : null}
      </div>

      <div className={styles.body}>
        {editing ? (
          <div className={styles.editor}>
            <textarea
              ref={textareaRef}
              className={styles.editorInput}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = `${Math.min(520, Math.max(150, e.target.scrollHeight))}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit('send');
              }}
            />
            <div className={styles.editorActions}>
              <span className={styles.editorHint}>
                {isUser ? 'Ctrl + Enter 保存并发送' : 'Ctrl + Enter 保存'}
              </span>
              <button type="button" className={styles.ghostBtn} onClick={() => setEditing(false)}>
                <IconClose size={13} />
                取消
              </button>
              <Tooltip label="只改文字，不产生新版本">
                <button type="button" className={styles.ghostBtn} onClick={() => submit('save')}>
                  保存
                </button>
              </Tooltip>
              {/*
                只有**用户提问**才有"保存并发送"。
                AI 回复的"另存变体"与「重新生成」是同一件事，多一个按钮只会让人犹豫；
                编辑回答的真实意图几乎总是"改掉写错的字"，所以只留保存。
              */}
              {isUser ? (
                <Tooltip label="另存为新提问并重新生成">
                  <button type="button" className={styles.primaryBtn} onClick={() => submit('send')}>
                    保存并发送
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {/* 思考链路：默认折叠由设置决定，点标题即可展开/收起 */}
            {display.showReasoning && reasoningText.length > 0 ? (
              <div className={styles.reasoning}>
                <button
                  type="button"
                  className={styles.reasoningHead}
                  onClick={() => setReasoningOverride(!reasoningOpen)}
                  aria-expanded={reasoningOpen}
                >
                  <span className={styles.reasoningChevron} data-open={reasoningOpen}>
                    <IconChevron size={12} />
                  </span>
                  <span>思考过程</span>
                  <span className={styles.reasoningMeta}>
                    {reasoningOpen ? '点击收起' : `${reasoningText.length} 字`}
                  </span>
                </button>
                {reasoningOpen ? (
                  <div
                    className={styles.reasoningBody}
                    ref={reasoningRef}
                    onScroll={onReasoningScroll}
                  >
                    {reasoningText}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 文件工具活动：像思考过程一样可折叠，一行一次调用 */}
            {toolActivity.length > 0 ? (
              <div className={styles.tools}>
                <button
                  type="button"
                  className={styles.toolsHead}
                  onClick={() => setToolsOverride(!toolsOpen)}
                  aria-expanded={toolsOpen}
                >
                  <span className={styles.reasoningChevron} data-open={toolsOpen} aria-hidden="true">
                    <IconChevron size={12} />
                  </span>
                  <span>文件工具</span>
                  <span className={styles.reasoningMeta}>
                    {toolsBusy
                      ? `执行中 ${toolsDone}/${toolActivity.length}`
                      : `${toolActivity.length} 次调用${toolsFailed > 0 ? ` · ${toolsFailed} 个失败` : ''}`}
                  </span>
                </button>
                {toolsOpen ? (
                  <div className={styles.toolsBody}>
                    {toolActivity.map((item, index) => {
                      const pending = item.result === null;
                      const failed = item.result?.isError === true;
                      return (
                        <div
                          key={`${item.call.id}-${index}`}
                          className={styles.toolRow}
                          data-state={pending ? 'pending' : failed ? 'error' : 'ok'}
                        >
                          <span className={styles.toolMark} aria-hidden="true">
                            {pending ? (
                              <span className={styles.toolSpinner} />
                            ) : failed ? (
                              '✕'
                            ) : (
                              '✓'
                            )}
                          </span>
                          <span className={styles.toolName}>{item.call.name}</span>
                          <span className={styles.toolArg}>{toolArgSummary(item.call)}</span>
                          {item.result === null ? (
                            <span className={styles.toolMore}>执行中…</span>
                          ) : (
                            <Tooltip
                              label={
                                item.result.content.length > TOOL_RESULT_TIP_MAX
                                  ? `${item.result.content.slice(0, TOOL_RESULT_TIP_MAX)}…`
                                  : item.result.content
                              }
                            >
                              <span className={styles.toolMore}>{failed ? '失败原因' : '结果'}</span>
                            </Tooltip>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={styles.bubbleRow}>
              {isUser ? actions : null}
              <div className={styles.bubble} data-waiting={isWaiting}>
                {isWaiting ? (
                  // 请求已发出但还没有任何内容：给三个跳动的点，而不是一个空气泡
                  <span className={styles.typing} role="status" aria-label="正在生成">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <Markdown text={text} />
                )}
              </div>
              {isUser ? null : actions}
            </div>

            {/*
              「每轮询问」的落点

              这一档停下来的原因是**在等用户决定**，不是写完了 —— 所以必须有一个
              看得见、点得到的东西，否则用户只会以为"怎么突然不写了"。
              刻意不塞进那一排图标按钮（它们是悬停才显形的）：那排按钮里多一个
              长得一样的图标，等于把"该你决定了"藏了起来。
            */}
            {canContinue && !editing ? (
              <div className={styles.continueRow}>
                <button
                  type="button"
                  className={styles.continueBtn}
                  onClick={() => onContinue(node.id)}
                >
                  <IconRefresh size={13} />
                  继续写
                </button>
                <span className={styles.continueHint}>
                  当前档位设为「每轮询问」，所以停在这里等你决定
                </span>
              </div>
            ) : null}

            {metaEntries.length > 0 ? (
              <div className={styles.metaRow}>
                {metaEntries.map((entry, index) => (
                  <span key={entry.id} className={styles.metaItem}>
                    {index > 0 ? (
                      <span className={styles.metaSep} aria-hidden="true">
                        ·
                      </span>
                    ) : null}
                    {entry.content}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

/**
 * 记忆化导出
 *
 * 这是本文件最大的一笔性能收益：流式生成时 MessageList 每 120ms 重渲染一次，
 * 没有 memo 的话**整条对话的每一条消息**都会跟着重渲染 ——
 * 每条都要重算信息栏、工具活动配对、变体位置。
 * 配合上面那对拆成数字的变体 props（以及模块级的复制函数），
 * 现在只有真正变化的那一条会重算。
 */
export const MessageItem = memo(MessageItemView);
