import { SettingGroup, SettingRow, Switch } from '@ui/primitives';
import { useSettingsStore } from '@ui/stores/settingsStore';

/**
 * 消息显示开关（会话设置面板里的快捷入口）
 *
 * 这些其实是**全局**显示偏好，和「设置 → 消息信息栏」读写的是同一份数据。
 * 放在这里是因为用户调参数时就在对话旁边，再去全局设置里翻一层太远；
 * 标题上写明是全局，避免误会成"只对本会话生效"。
 *
 * 组件自己从 store 取数据，不接收 props —— 这样它插在哪个面板里都能用，
 * 也不会跟宿主面板的局部变量名耦合。
 *
 * 【为什么这里没有「显示缓存命中率」】那一项属于"信息栏显示哪些字段"，
 * 在「设置 → 消息信息栏」里改就够了；这个快捷入口只留"看着生成过程"相关的开关。
 */
export function DisplayToggles() {
  const display = useSettingsStore((s) => s.settings.messageDisplay);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingGroup title="消息显示（全局）" help="与「设置 → 消息信息栏」是同一份配置">
      <SettingRow
        label="显示思考和工具使用过程"
        help="思考链路与文件工具的执行过程；关掉只是不显示，内容仍然保存（导出里也在）"
      >
        <Switch
          label="显示思考和工具使用过程"
          checked={display.showReasoning}
          onChange={(value) => update({ messageDisplay: { showReasoning: value } })}
        />
      </SettingRow>

      <SettingRow label="思考过程默认展开" help="开：一直展开。关：思考时展开、一出正文就折叠">
        <Switch
          label="思考过程默认展开"
          checked={display.reasoningDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { reasoningDefaultExpanded: value } })}
        />
      </SettingRow>

      <SettingRow label="工具使用过程默认展开" help="开：一直展开。关：执行工具时展开、一出正文就折叠">
        <Switch
          label="工具使用过程默认展开"
          checked={display.toolsDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { toolsDefaultExpanded: value } })}
        />
      </SettingRow>

      <SettingRow
        label="跟随过程自动展开"
        help="开：思考时展开思考框、执行工具时展开工具框，一开始说正文就都折叠（中途再思考或调用工具会再展开）。关：只由你手动开合。只影响正在生成的那条"
      >
        <Switch
          label="跟随过程自动展开"
          checked={display.followProgress}
          onChange={(value) => update({ messageDisplay: { followProgress: value } })}
        />
      </SettingRow>
    </SettingGroup>
  );
}
