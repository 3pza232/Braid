import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveConfig } from '@domain/rules/resolveConfig';
import { estimateTokens } from '@domain/value-objects/usage';
import { estimatedRounds, WRITING_MODES, type WritingMode } from '@domain/value-objects/writingMode';
import { useChatStore } from '@ui/stores/chatStore';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { Dropdown, Tooltip } from '@ui/primitives';
import { IconSend, IconStop } from './Icons';
import styles from './Composer.module.css';

/**
 * 输入区
 *
 * 布局：发送按钮贴在输入框**右侧**（和大多数 IM 一致，无需把视线移到工具栏）；
 * 工具栏只放输出档位与字数统计。
 *
 * 档位按钮直接读写**会话级**档位（与「本会话设置」里的是同一份数据），
 * 两处永远同步 —— 因为它们读写同一个字段，而不是各存一份。
 */
export function Composer() {
  const [text, setText] = useState('');
  const conversation = useChatStore((s) => s.conversation);
  const patchConversation = useChatStore((s) => s.patchConversation);
  const send = useChatStore((s) => s.send);
  const settings = useSettingsStore((s) => s.settings);

  const config = useMemo(() => resolveConfig(settings, conversation), [settings, conversation]);

  // 有消息在流式生成时，发送键变成停止键（用消息 id 而不是布尔，还能知道是哪条在长）
  const isStreaming = useChatStore((s) => s.streamingMessageId !== null);
  const stop = useChatStore((s) => s.stop);
  const [sending, setSending] = useState(false);
  const canSend = text.trim().length > 0 && !isStreaming && !sending;
  const tokens = useMemo(() => estimateTokens(text), [text]);

  /**
   * 发送
   *
   * **只有真的被接受时才清空草稿**。被闸门拦住时（上下文超预算、会话已不存在……）
   * 打好的字要留在输入框里：用户刚才的努力不该因为"没被接受"而消失，
   * 而且要让他能直接改一改再发一次。早先这里是无条件 `setText('')`，
   * 于是"上下文满了 → 按发送 → 字没了、会话里也没有"。
   */
  const submit = () => {
    const next = text.trim();
    if (!next || sending) return;
    setSending(true);
    void send(next).then((accepted) => {
      setSending(false);
      if (accepted) setText('');
    });
  };

  const sendWithModifier = settings.composer.sendShortcut === 'ctrlEnter';
  const maxInputHeight = settings.composer.maxInputHeight;

  /*
   * 高度自适应：随内容长高，到设置里的上限就内部滚动
   *
   * 手法是每次渲染前把高度归零再量 scrollHeight —— 这是让 textarea
   * 收缩回短内容的唯一可靠办法（只长不缩是这类实现最常见的 bug）。
   */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxInputHeight)}px`;
  }, [text, maxInputHeight]);

  const modes: Array<{ id: WritingMode | 'chat'; label: string; hint: string }> = [
    { id: 'chat', label: '普通', hint: '单次生成，不续写' },
    ...WRITING_MODES.filter((mode) => settings.writingModes[mode].enabled).map((mode) => {
      const preset = settings.writingModes[mode];
      return {
        id: mode,
        label: preset.label,
        hint: `下限 ${preset.minOutputChars.toLocaleString()} 字 · 约 ${estimatedRounds(preset)} 轮`,
      };
    }),
  ];

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.inputRow}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              const shouldSend = sendWithModifier ? event.ctrlKey || event.metaKey : !event.shiftKey;
              if (!shouldSend) return;
              event.preventDefault();
              if (canSend) submit();
            }}
            /* 提示只留最短一句：发送键用法在右侧按钮的 tooltip 里，
               占位符里塞括号解释会把输入框变成说明书 */
            placeholder="说点什么…"
            rows={1}
            aria-label="消息输入框"
          />

          <Tooltip
            label={
              isStreaming
                ? '停止生成'
                : sendWithModifier
                  ? '发送 (Ctrl + Enter)'
                  : '发送 (Enter)'
            }
          >
            <button
              type="button"
              className={styles.send}
              data-variant={isStreaming ? 'stop' : 'send'}
              disabled={!isStreaming && !canSend}
              aria-label={isStreaming ? '停止生成' : '发送'}
              onClick={isStreaming ? stop : submit}
            >
              {isStreaming ? <IconStop size={16} /> : <IconSend size={16} />}
            </button>
          </Tooltip>
        </div>

        <div className={styles.toolbar}>
          {/* 模型配置放在档位左边：先选"用哪个模型"，再选"写多长" */}
          <Dropdown
            value={conversation.modelProfileId ?? 'inherit'}
            width={150}
            onChange={(id) => patchConversation({ modelProfileId: id === 'inherit' ? null : id })}
            options={[
              { value: 'inherit', label: '跟随默认' },
              ...settings.model.profiles.map((profile) => ({
                value: profile.id,
                label: profile.name || profile.model || '未命名',
              })),
            ]}
          />

          <div className={styles.modes} role="group" aria-label="输出档位">
            {modes.map((item) => (
              <Tooltip key={item.id} label={item.hint}>
                <button
                  type="button"
                  className={styles.modeBtn}
                  data-active={config.writingMode === item.id}
                  onClick={() => patchConversation({ writingMode: item.id })}
                >
                  {item.label}
                </button>
              </Tooltip>
            ))}
          </div>

          {!config.model ? (
            <Tooltip label="尚未填写模型名 —— 打开设置 → 模型与凭据">
              <span className={styles.warn}>未配置模型</span>
            </Tooltip>
          ) : null}

          <Tooltip label="内容只发送到你配置的端点 · 密钥不落盘、不进日志">
            <span className={styles.counter}>
              {text.length} 字 · 约 {tokens} tokens
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
