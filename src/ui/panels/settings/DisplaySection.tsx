import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { Segmented, SettingGroup, SettingRow, Switch } from '@ui/primitives';
import { MetaFieldList } from '../MetaFieldList';

interface DisplaySectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/**
 * 消息信息栏分区
 *
 * 从 `SettingsPanel` 搬出来的第四个分区。它几乎只是给 `MetaFieldList` 搭个壳 ——
 * 这个分区本来就是"可配置字段"那套机制的入口，真正的逻辑在那个组件里。
 */
export function DisplaySection({ settings, update }: DisplaySectionProps) {
  return (
    <SettingGroup
      title="消息信息栏"
      help="回复下方那行小字显示哪些内容、按什么顺序。拖动左侧点阵手柄调整顺序（键盘上下键也可以）"
    >
      <MetaFieldList
        fields={settings.messageDisplay.metaFields}
        onChange={(metaFields) => update({ messageDisplay: { metaFields } })}
      />
      <SettingRow label="操作按钮" help="选择操作按钮的显示方式">
        <Segmented
          value={settings.messageDisplay.actionBarTrigger}
          onChange={(value) => update({ messageDisplay: { actionBarTrigger: value } })}
          options={[
            { value: 'hover', label: '悬停显示' },
            { value: 'always', label: '常驻显示' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="显示思考过程"
        help="带有 reasoning / thinking 输出的模型（如 DeepSeek 的推理模式）会在回复上方给出可折叠的思考链路。关掉只是不展示，内容仍会被保存，随时可以打开回看"
      >
        <Switch
          label="显示思考过程"
          checked={settings.messageDisplay.showReasoning}
          onChange={(value) => update({ messageDisplay: { showReasoning: value } })}
        />
      </SettingRow>
      <SettingRow
        label="思考过程默认展开"
        help="只影响初始状态；你自己点过之后，以你的选择为准（不会因为流式输出被重置）"
      >
        <Switch
          label="思考过程默认展开"
          checked={settings.messageDisplay.reasoningDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { reasoningDefaultExpanded: value } })}
        />
      </SettingRow>
    </SettingGroup>
  );
}
