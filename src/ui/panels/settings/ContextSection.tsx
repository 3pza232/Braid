import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { NumberField, Segmented, SettingGroup, SettingRow, Slider } from '@ui/primitives';

interface ContextSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/**
 * 上下文分区
 *
 * 从 `SettingsPanel` 搬出来的第二个分区。搬它的原则：**只搬家，不改语义** ——
 * JSX、取值、文案一字不动，只是把 `settings` / `update` 换成 props。
 * 验证靠面板的冒烟测试（每个分区都渲染一遍），而不是通读比对。
 */
export function ContextSection({ settings, update }: ContextSectionProps) {
  return (
    <SettingGroup
      title="上下文"
      help="超预算时按「信息损失从小到大」降级：先压缩过长的工具输出，再整轮丢弃最早的历史（保留最近几轮原文）。做了什么会在顶栏如实写明 —— 发出去的内容与屏幕上看到的不再完全一致时，用户有权知道"
    >
      <SettingRow
        label="上下文长度"
        help="默认 1,000,000 tokens。实际生效值 = min(这里设定的值, 模型真实上限) − 输出预留；界面上会显示实际值，不会静默失败"
      >
        <NumberField
          value={settings.context.maxContextTokens}
          min={4096}
          max={4_000_000}
          step={4096}
          onChange={(value) => update({ context: { maxContextTokens: value } })}
          suffix="tok"
          width={150}
        />
      </SettingRow>
      <SettingRow label="为输出预留" help="从上下文预算里先扣掉的部分，避免请求被上游拒绝">
        <NumberField
          value={settings.context.reservedForOutput}
          min={512}
          max={131072}
          step={512}
          onChange={(value) => update({ context: { reservedForOutput: value } })}
          suffix="tok"
          width={150}
        />
      </SettingRow>
      <SettingRow
        label="保留最近原文"
        help="裁剪时至少保留最近多少轮的完整原文（一轮 = 一问一答，含其间的工具往来）。设小会丢得更狠，设大会让更早的历史先被压"
      >
        <NumberField
          value={settings.context.keepRecentMessages}
          min={1}
          max={200}
          step={1}
          onChange={(value) => update({ context: { keepRecentMessages: value } })}
          suffix="轮"
          width={140}
        />
      </SettingRow>
      <SettingRow
        label="上下文压缩"
        help="用量涨到触发线时，把最早的历史改写成一段纪要（保留人物、设定、已做的事，丢掉寒暄与过程细节），原文不会被删，可在顶栏的上下文菜单里回看。关掉后绝不自动改写：真的超出上限时会拦住发送，由你决定压不压"
      >
        <Segmented
          value={settings.context.compression}
          onChange={(value) => update({ context: { compression: value } })}
          options={[
            { value: 'auto', label: '自动压缩' },
            { value: 'off', label: '不压缩' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="压缩触发线"
        help="上下文用量达到这个比例就自动压缩。默认 85% —— 留一段缓冲，等到贴边才动手往往就来不及了（压缩本身也要占用一点上下文）"
      >
        <Slider
          value={settings.context.compressAt}
          min={0.5}
          max={0.95}
          step={0.05}
          onChange={(value) => update({ context: { compressAt: value } })}
          format={(value) => `${Math.round(value * 100)}%`}
        />
      </SettingRow>
    </SettingGroup>
  );
}
