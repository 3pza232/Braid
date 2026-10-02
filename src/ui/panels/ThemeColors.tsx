import { useState } from 'react';
import type { Theme } from '@ports/Theme';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useTheme } from '@ui/theme/ThemeProvider';
import { COPY_FAILED_MESSAGE, copyText } from '@ui/utils/clipboard';
import { useUiStore } from '@ui/stores/uiStore';
import { Tooltip } from '@ui/primitives';
import styles from './ThemeColors.module.css';

/**
 * 语义颜色逐项编辑器
 *
 * 主题里所有**语义色**都能单独覆盖：各层背景、文本、边框、强调色、
 * 状态色、四类气泡、滚动条、选区……key 是主题 token 的路径，
 * 应用层把它换算成 CSS 变量写在主题**之上** —— 换主题不清空覆盖，
 * 删掉某一项就回到主题默认。每一项都能单独重置。
 *
 * 整体收在**一个**折叠块里（默认收起）：40 多项颜色铺开会把这一屏
 * 完全占满，而绝大多数时候用户打开设置并不是为了调色。
 */

interface TokenSpec {
  path: string;
  label: string;
}

interface TokenGroup {
  label: string;
  hint?: string;
  tokens: TokenSpec[];
}

const GROUPS: readonly TokenGroup[] = [
  {
    label: '背景',
    tokens: [
      { path: 'bg.canvas', label: '应用底色' },
      { path: 'bg.surface', label: '面板底色' },
      { path: 'bg.raised', label: '浮起面板 / 悬停卡片' },
      { path: 'bg.sunken', label: '凹陷区域（输入框、悬停）' },
      { path: 'bg.overlay', label: '遮罩（弹窗暗层）' },
    ],
  },
  {
    label: '文本',
    tokens: [
      { path: 'text.primary', label: '主要文字' },
      { path: 'text.secondary', label: '次要文字' },
      { path: 'text.tertiary', label: '辅助文字（时间戳等）' },
      { path: 'text.disabled', label: '禁用文字' },
      { path: 'text.link', label: '链接' },
    ],
  },
  {
    label: '边框',
    tokens: [
      { path: 'border.subtle', label: '细边框' },
      { path: 'border.default', label: '常规边框' },
      { path: 'border.strong', label: '强调边框' },
      { path: 'border.focus', label: '聚焦边框' },
    ],
  },
  {
    label: '强调色',
    hint: '按钮、选中态、进度条等交互元素的主色',
    tokens: [
      { path: 'accent.default', label: '默认' },
      { path: 'accent.hover', label: '悬停' },
      { path: 'accent.active', label: '按下' },
      { path: 'accent.onAccent', label: '强调色上的文字' },
    ],
  },
  {
    label: '状态色',
    tokens: [
      { path: 'status.success', label: '成功' },
      { path: 'status.warning', label: '警告' },
      { path: 'status.danger', label: '危险' },
      { path: 'status.info', label: '信息' },
    ],
  },
  {
    label: '气泡',
    hint: '对话气泡的底色与文字颜色',
    tokens: [
      { path: 'role.userBubble', label: '用户气泡底色' },
      { path: 'role.userText', label: '用户气泡文字' },
      { path: 'role.assistantBubble', label: 'AI 气泡底色' },
      { path: 'role.assistantText', label: 'AI 气泡文字' },
      { path: 'role.systemBubble', label: '系统气泡底色' },
      { path: 'role.toolBubble', label: '工具气泡底色' },
    ],
  },
  {
    label: '其他',
    tokens: [
      { path: 'selection', label: '文字选中背景' },
      { path: 'caret', label: '光标' },
      { path: 'scrollbarThumb', label: '滚动条' },
    ],
  },
];

/** 原生 color input 只认 hex；rgba / color-mix 给不出预览，只能显示默认值文本 */
function toHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  return null;
}

function tokenValue(theme: Theme, path: string): string {
  let current: unknown = theme.tokens.semantic;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : '';
}

export function ThemeColors() {
  const { theme } = useTheme();
  const customColors = useSettingsStore((s) => s.settings.appearance.customColors);
  const update = useSettingsStore((s) => s.update);

  const setValue = (path: string, value: string) => {
    const next = { ...customColors };
    if (value) next[path] = value;
    else delete next[path];
    update({ appearance: { customColors: next } });
  };

  const overridden = Object.keys(customColors).length;

  /** 整个颜色区默认收起：打开设置时不该被 40 多项颜色占满一屏 */
  const [open, setOpen] = useState(false);
  /** 刚复制完片段的项，短暂显示"已复制" */
  const [copied, setCopied] = useState<string | null>(null);

  /**
   * 「同步」：把这一项的覆盖复制成主题文件片段
   *
   * 为什么是复制而不是直接写 themes/*.json：浏览器写不了项目目录。
   * 用户攒好的自定义配色想变成正式主题时，逐项粘进文件即可。
   */
  const copySnippet = async (path: string, value: string) => {
    const [group, key] = path.split('.');
    const snippet = JSON.stringify(
      { tokens: { semantic: key ? { [group]: { [key]: value } } : { [group]: value } } },
      null,
      2,
    );
    const copied = await copyText(snippet);
    if (!copied) {
      // 失败要说清楚原因：早先这里无论如何都显示"已复制"，等于在骗人
      useUiStore.getState().pushNotice({ tone: 'error', message: COPY_FAILED_MESSAGE });
      return;
    }
    setCopied(path);
    window.setTimeout(() => setCopied((current) => (current === path ? null : current)), 1600);
  };

  return (
    <div className={styles.editor}>
      {/*
        全局恢复：只在真的有自定义时出现
        没改过颜色时它点了也没意义，露在那里只会让人怀疑"我是不是已经改了什么"
      */}
      {overridden > 0 ? (
        <div className={styles.toolbar}>
          <Tooltip label={`把 ${overridden} 项自定义颜色全部恢复为主题默认`}>
            <button
              type="button"
              className={styles.resetAll}
              onClick={() => update({ appearance: { customColors: {} } })}
            >
              恢复主题颜色
            </button>
          </Tooltip>
        </div>
      ) : null}

      <section className={styles.group}>
        <button
          type="button"
          className={styles.groupHead}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className={styles.chevron} data-open={open} aria-hidden="true">
            ▸
          </span>
          <span className={styles.groupTitle}>主题颜色</span>
          {overridden > 0 ? <span className={styles.groupCount}>{overridden} 项已自定义</span> : null}
        </button>

        {open ? (
          <div className={styles.rows}>
            {GROUPS.map((group) => {
              const groupOverrides = group.tokens.filter(
                (spec) => customColors[spec.path] !== undefined,
              ).length;
              return (
                <div key={group.label} className={styles.subGroup}>
                  <div className={styles.subTitle}>
                    <span className={styles.groupTitle}>{group.label}</span>
                    {groupOverrides > 0 ? (
                      <span className={styles.groupCount}>{groupOverrides} 项自定义</span>
                    ) : null}
                  </div>
                  {group.hint ? <p className={styles.groupHint}>{group.hint}</p> : null}

                  {group.tokens.map((spec) => {
                    const override = customColors[spec.path];
                    const effective = override ?? tokenValue(theme, spec.path);
                    const hex = toHex(effective) ?? '#000000';
                    const isOverridden = override !== undefined;
                    const fallback = tokenValue(theme, spec.path) || '—';
                    return (
                      /*
                       * 这里**不能用 `<label>` 包住整行**
                       *
                       * label 的默认行为是"点它等于点它关联的控件"，而这一行里
                       * 有一个 `<input type="color">`：于是点「同步」、点颜色代码、
                       * 点默认值……全都会去打开取色器，同步按钮的点击范围被
                       * 整行抢走（用户看到的"点不中"就是这么来的）。
                       * 改用 div，颜色输入框自带 aria-label，无障碍不受影响。
                       */
                      <div key={spec.path} className={styles.row}>
                        <span className={styles.rowLabel}>{spec.label}</span>

                        {isOverridden ? (
                          <span className={styles.rowActions}>
                            <Tooltip label="复制为主题文件片段，粘进 themes/*.json 即可">
                              <button
                                type="button"
                                className={styles.syncOne}
                                onClick={() => void copySnippet(spec.path, override)}
                              >
                                {copied === spec.path ? '已复制' : '同步'}
                              </button>
                            </Tooltip>
                            <Tooltip label={`恢复为主题默认值：${fallback}`}>
                              <button
                                type="button"
                                className={styles.resetRow}
                                onClick={() => setValue(spec.path, '')}
                              >
                                恢复
                              </button>
                            </Tooltip>
                          </span>
                        ) : null}

                        <span className={styles.defaultValue} title={`主题默认：${effective || '—'}`}>
                          {isOverridden ? `默认 ${fallback}` : effective}
                        </span>

                        <input
                          type="color"
                          className={styles.colorInput}
                          data-overridden={isOverridden}
                          value={hex}
                          onChange={(event) => setValue(spec.path, event.target.value)}
                          aria-label={`${spec.label}，当前值覆盖主题默认`}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
