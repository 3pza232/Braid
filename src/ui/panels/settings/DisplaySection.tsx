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
        label="显示思考和工具使用过程"
        help="思考链路与文件工具的执行过程；关掉只是不显示，内容仍会保存（导出里也在）"
      >
        <Switch
          label="显示思考和工具使用过程"
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

      <SettingRow
        label="工具使用过程默认展开"
        help="与「思考过程默认展开」对称：开了一直展开，关了则执行工具时展开、一出正文就折叠"
      >
        <Switch
          label="工具使用过程默认展开"
          checked={settings.messageDisplay.toolsDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { toolsDefaultExpanded: value } })}
        />
      </SettingRow>

      <SettingRow
        label="跟随过程自动展开"
        help="开：思考时展开思考框、执行工具时展开工具框，一开始说正文就都折叠（中途再思考或调用工具会再展开）。关：只由你手动开合。只影响正在生成的那条"
      >
        <Switch
          label="跟随过程自动展开"
          checked={settings.messageDisplay.followProgress}
          onChange={(value) => update({ messageDisplay: { followProgress: value } })}
        />
      </SettingRow>
      </SettingGroup>
  );
}
