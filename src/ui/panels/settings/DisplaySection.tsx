import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { Segmented, SettingGroup, SettingRow, Switch } from '@ui/primitives';
import { MetaFieldList } from '../MetaFieldList';

interface DisplaySectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/** 消息信息栏分区（回复下方那行小字的显示项与顺序） */
export function DisplaySection({ settings, update }: DisplaySectionProps) {
  return (
    <SettingGroup title="消息信息栏" help="回复下方那行小字显示什么、按什么顺序">
      <MetaFieldList
        fields={settings.messageDisplay.metaFields}
        onChange={(metaFields) => update({ messageDisplay: { metaFields } })}
      />
      <SettingRow label="操作按钮" help="鼠标悬停才出现，还是常驻">
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
        help="推理模型会在回复上方给出可折叠的思考链路；关掉只是不显示，内容仍会保存"
      >
        <Switch
          label="显示思考过程"
          checked={settings.messageDisplay.showReasoning}
          onChange={(value) => update({ messageDisplay: { showReasoning: value } })}
        />
      </SettingRow>
      <SettingRow label="思考过程默认展开" help="只影响初始状态，你点过之后以你的选择为准">
        <Switch
          label="思考过程默认展开"
          checked={settings.messageDisplay.reasoningDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { reasoningDefaultExpanded: value } })}
        />
      </SettingRow>
    </SettingGroup>
  );
}
