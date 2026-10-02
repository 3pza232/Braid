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
 */
export function DisplayToggles() {
  const display = useSettingsStore((s) => s.settings.messageDisplay);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingGroup title="消息显示（全局）" help="与「设置 → 消息信息栏」是同一份配置">
      <SettingRow label="显示思考过程" help="推理模型的可折叠思考链路；关掉只是不显示">
        <Switch
          label="显示思考过程"
          checked={display.showReasoning}
          onChange={(value) => update({ messageDisplay: { showReasoning: value } })}
        />
      </SettingRow>

      <SettingRow
        label="思考过程默认展开"
        help="开：一直展开。关：一出正文就自动折叠"
      >
        <Switch
          label="思考过程默认展开"
          checked={display.reasoningDefaultExpanded}
          onChange={(value) => update({ messageDisplay: { reasoningDefaultExpanded: value } })}
        />
      </SettingRow>

      <SettingRow label="显示缓存命中率" help="服务端上报时是精确值；估算值会带「≈」">
        <Switch
          label="显示缓存命中率"
          checked={display.metaFields.find((field) => field.id === 'cache')?.enabled ?? false}
          onChange={(value) =>
            update({
              messageDisplay: {
                metaFields: display.metaFields.map((field) =>
                  field.id === 'cache' ? { ...field, enabled: value } : field,
                ),
              },
            })
          }
        />
      </SettingRow>
    </SettingGroup>
  );
}
