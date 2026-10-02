import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { Dropdown, NumberField, Segmented, SettingGroup, SettingRow, Switch, TextField, Tooltip } from '@ui/primitives';
import { useTheme } from '@ui/theme/ThemeProvider';
import { ThemeColors } from '../ThemeColors';
import styles from './sections.module.css';

interface AppearanceSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/** 外观分区（从 `SettingsPanel` 逐字搬出，未改语义） */
export function AppearanceSection({ settings, update }: AppearanceSectionProps) {
  /* 主题数据就是这个分区的全部内容，自己取比从上面转手更内聚 */
  const { themes, preference, setPreference } = useTheme();

  return (
    <>
      <SettingGroup title="外观">
        <SettingRow
          label="主题"
          help={`共 ${themes.length + 1} 项，含跟随系统。自定义主题：往 themes/ 放一个 json，只写要改的颜色`}
        >
          <Dropdown
            value={preference}
            onChange={(value) => setPreference(value as typeof preference)}
            width={200}
            options={[
              { value: 'system', label: '跟随系统' },
              ...themes.map((theme) => ({
                value: theme.id,
                label: `${theme.name}${theme.colorScheme === 'dark' ? ' ·深' : ' ·浅'}`,
              })),
            ]}
          />
        </SettingRow>
        <ThemeColors />
        <SettingRow
          label="强调色"
          help="覆盖主题自带的强调色，只影响你本机的观感；悬停、按下、浅底色会自动派生"
        >
          <div className={styles.inlineField}>
            <Tooltip label="选择颜色">
              <input
                type="color"
                className={styles.colorInput}
                value={settings.appearance.accentColor || '#2563EB'}
                onChange={(e) => update({ appearance: { accentColor: e.target.value } })}
                aria-label="强调色"
              />
            </Tooltip>
            <TextField
              mono
              width={130}
              value={settings.appearance.accentColor}
              onChange={(value) => update({ appearance: { accentColor: value } })}
              placeholder="留空跟随主题"
            />
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => update({ appearance: { accentColor: '' } })}
            >
              跟随主题
            </button>
          </div>
        </SettingRow>
        <SettingRow label="消息样式" help="气泡式左右分栏；纯文本式去掉气泡，适合长文写作阅读">
          <Segmented
            value={settings.appearance.bubbleStyle}
            onChange={(value) => update({ appearance: { bubbleStyle: value } })}
            options={[
              { value: 'bubble', label: '气泡' },
              { value: 'plain', label: '纯文本' },
            ]}
          />
        </SettingRow>
        <SettingRow label="显示头像" help="关闭后消息区更紧凑，只靠对齐区分角色">
          <Switch
            label="显示头像"
            checked={settings.appearance.showAvatars}
            onChange={(value) => update({ appearance: { showAvatars: value } })}
          />
        </SettingRow>
        <SettingRow label="正文字号" help="影响消息正文与输入框，不影响界面其它元素">
          <Segmented
            value={settings.appearance.contentFontSize}
            onChange={(value) => update({ appearance: { contentFontSize: value } })}
            options={[
              { value: 'sm', label: '小' },
              { value: 'base', label: '中' },
              { value: 'lg', label: '大' },
            ]}
          />
        </SettingRow>
        <SettingRow label="内容宽度" help="消息区的最大宽度。宽屏下窄一点更容易读长文">
          <NumberField
            value={settings.appearance.contentMaxWidth}
            min={560}
            max={1600}
            step={20}
            suffix="px"
            width={140}
            onChange={(value) => update({ appearance: { contentMaxWidth: value } })}
          />
        </SettingRow>
        <SettingRow label="消息间距" help="紧凑模式一屏能看到更多内容">
          <Segmented
            value={settings.appearance.messageDensity}
            onChange={(value) => update({ appearance: { messageDensity: value } })}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'comfortable', label: '宽松' },
            ]}
          />
        </SettingRow>
        <SettingRow label="减少动效" help="关闭过渡与动画，适合低配置设备">
          <Switch
            label="减少动效"
            checked={settings.appearance.reduceMotion}
            onChange={(value) => update({ appearance: { reduceMotion: value } })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
