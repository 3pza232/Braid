import { useEffect, useState } from 'react';

import type { WritingMode } from '@domain/value-objects/writingMode';
import { IconClose } from '@ui/components/Icons';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useModalFocus } from '@ui/hooks/useModalFocus';
import { useOverlayDismiss } from '@ui/hooks/useOverlayDismiss';
import { useUiStore } from '@ui/stores/uiStore';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { ComposerSection } from './settings/ComposerSection';
import { ContextSection } from './settings/ContextSection';
import { DisplaySection } from './settings/DisplaySection';
import { IdentitySection } from './settings/IdentitySection';
import { ModelSection } from './settings/ModelSection';
import { SamplingSection } from './settings/SamplingSection';
import { WritingSection } from './settings/WritingSection';
import styles from './SettingsPanel.module.css';

type SectionId =
  | 'identity'
  | 'model'
  | 'sampling'
  | 'context'
  | 'writing'
  | 'display'
  | 'appearance'
  | 'composer'
  | 'about';

/**
 * 分区清单
 *
 * 【为什么没有「工作区」】工作区是**每个会话各自选的目录**，不是一个全局默认值 ——
 * 放到全局设置里只会让人问"那到底是哪个目录"。它的唯一入口在会话设置与顶栏。
 */
const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'identity', label: '身份' },
  { id: 'model', label: '模型与凭据' },
  { id: 'sampling', label: '生成参数' },
  { id: 'context', label: '上下文' },
  { id: 'writing', label: '续写模式' },
  { id: 'display', label: '消息信息栏' },
  { id: 'appearance', label: '外观' },
  { id: 'composer', label: '输入与快捷键' },
  { id: 'about', label: '关于' },
];

/**
 * 全局设置
 *
 * 两条原则：
 *  1. **正文只留标签与控件，解释全部收进 `HelpTip`** —— 所以能塞下 9 组、40 多个可调项而不显臃肿；
 *  2. 左侧分页而不是长滚动 —— 用户要的是"能改的东西多"，不是"要滚很久"。
 *
 * 这里的所有值都是**全局默认**，会被角色预设与会话设置逐层覆盖。
 */
export function SettingsPanel() {
  const closePanel = useUiStore((s) => s.closePanel);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const error = useSettingsStore((s) => s.error);

  /*
   * 总是从第一页开始
   *
   * 曾经有一个"从别处跳到指定分页"的入口（`uiStore.settingsSection`）——
   * 但**没有任何调用方**，而它带来一类真实风险：传进来一个本面板不渲染的 id
   * 就会得到"内容空白、左侧没有高亮"。没有调用方的机制不如没有：
   * 真要跳转时，加一个带类型的入口（而不是一个自由字符串）。
   */
  const [section, setSection] = useState<SectionId>('identity');
  const [modeTab, setModeTab] = useState<WritingMode>('long');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePanel]);

  const preset = settings.writingModes[modeTab];

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
        aria-label="设置"
        // tabIndex=-1：允许"没有可聚焦元素时"把焦点收到面板本身，但不进 Tab 序列
        tabIndex={-1}
        onKeyDown={modalFocus.onKeyDown}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>设置</h2>
          <span className={styles.subtitle}>全局默认值 · 会被角色预设与会话设置逐层覆盖</span>
          <button type="button" className={styles.close} onClick={closePanel} aria-label="关闭设置">
            <IconClose size={17} />
          </button>
        </header>

        <div className={styles.layout}>
          <nav className={styles.nav} aria-label="设置分类">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.navItem}
                data-active={section === item.id}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {error ? <p className={styles.error}>保存设置失败：{error}</p> : null}

            {/* ── 身份 ── */}
            {section === 'identity' ? <IdentitySection settings={settings} update={update} /> : null}

            {/* ── 模型与凭据 ── */}
            {section === 'model' ? <ModelSection settings={settings} update={update} /> : null}

            {/*
              ── 余额 ──
              与「模型与凭据」同一个页面：余额脚本属于**当前那份模型配置**，
              换端点就必须一起换（不同服务商的余额接口完全不同）。
              分在两页只会让人漏改其中一页。
            */}


            {/* ── 生成参数 ── */}
            {section === 'sampling' ? <SamplingSection settings={settings} update={update} /> : null}

            {/* ── 上下文 ── */}
            {section === 'context' ? <ContextSection settings={settings} update={update} /> : null}

            {/* ── 输出档位 ── */}
            {section === 'writing' ? (
              <WritingSection
                settings={settings}
                update={update}
                modeTab={modeTab}
                onModeTabChange={setModeTab}
                preset={preset}
              />
            ) : null}

            {/* ── 消息信息栏 ── */}
            {section === 'display' ? <DisplaySection settings={settings} update={update} /> : null}

            {/* ── 外观 ── */}
            {section === 'appearance' ? <AppearanceSection settings={settings} update={update} /> : null}

            {/* ── 输入与快捷键 ── */}
            {section === 'composer' ? <ComposerSection settings={settings} update={update} /> : null}

            {/* ── 工作区 ── */}

            {/* ── 关于 ── */}
            {section === 'about' ? <AboutSection /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
