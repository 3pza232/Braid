import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { NumberField, Segmented, SettingGroup, SettingRow } from '@ui/primitives';
import styles from './sections.module.css';

interface ComposerSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/**
 * 输入与快捷键分区
 *
 * 从 `SettingsPanel` 搬出来的第五个分区。它是第一个**带样式依赖**的分区
 * （快捷键那块用了一个类），因此引入了 `sections.module.css` ——
 * 共用类集中放那儿，才不会在父面板里变成"定义了没人用"的假死样式。
 */
export function ComposerSection({ settings, update }: ComposerSectionProps) {
  return (
    <SettingGroup title="输入与快捷键">
      <SettingRow
        label="发送键"
        help="Enter 发送更顺手；Ctrl+Enter 发送更安全，适合经常写多段的人"
      >
        <Segmented
          value={settings.composer.sendShortcut}
          onChange={(value) => update({ composer: { sendShortcut: value } })}
          options={[
            { value: 'enter', label: 'Enter 发送' },
            { value: 'ctrlEnter', label: 'Ctrl + Enter 发送' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="输入框最大高度"
        help="输入框随内容自动长高，长到这个高度就内部滚动，不会把消息区顶没"
      >
        <NumberField
          value={settings.composer.maxInputHeight}
          min={120}
          max={600}
          step={20}
          suffix="px"
          width={130}
          onChange={(value) => update({ composer: { maxInputHeight: value } })}
        />
      </SettingRow>
      <SettingRow label="全局快捷键" stacked>
        <div className={styles.shortcutList}>
          <span><kbd>Ctrl</kbd> + <kbd>B</kbd> 收起 / 展开侧栏</span>
          <span><kbd>Ctrl</kbd> + <kbd>,</kbd> 打开全局设置</span>
          <span><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> 打开角色预设</span>
          <span><kbd>Esc</kbd> 关闭当前面板</span>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}
