import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { WRITING_MODES, estimatedRounds, softMaxOf, type WritingMode } from '@domain/value-objects/writingMode';
import { NumberField, Segmented, SettingGroup, SettingRow, Slider, Switch, TextArea } from '@ui/primitives';

interface WritingSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
  /** 正在编辑的档位（属于界面状态，仍由面板持有，这里只读与回调） */
  modeTab: WritingMode;
  onModeTabChange: (mode: WritingMode) => void;
  /** `settings.writingModes[modeTab]`，面板已算好，避免在两个地方各取一次 */
  preset: AppSettings['writingModes'][WritingMode];
}

/**
 * 续写模式分区
 *
 * 从 `SettingsPanel` 搬出来的第三个分区。原则依旧是**只搬家、不改语义**。
 * `modeTab` 与 `preset` 由面板传进来而不是在这里自己算：档位切换要同时影响
 * 别的地方（面板里还有别的分区读它），状态留在上层才是单一来源。
 */
export function WritingSection({
  settings,
  update,
  modeTab,
  onModeTabChange,
  preset,
}: WritingSectionProps) {
  return (
    <SettingGroup
      title="续写模式"
      help="字数下限决定 AI 至少写多少字：一轮写不完就自动接着写，直到达标。软上限是「到此为止」的边界，避免为凑字数跑飞；停顿检测在连续几轮没有新增内容时中止，防止原地打转"
    >
      <SettingRow label="默认档位" help="新建会话时使用的档位">
        <Segmented
          value={settings.defaultWritingMode}
          onChange={(value) => update({ defaultWritingMode: value })}
          options={[
            { value: 'chat', label: '普通' },
            ...WRITING_MODES.map((mode) => ({ value: mode, label: settings.writingModes[mode].label })),
          ]}
        />
      </SettingRow>
      <SettingRow label="正在编辑的档位" stacked>
        <Segmented
          value={modeTab}
          onChange={onModeTabChange}
          options={WRITING_MODES.map((mode) => ({
            value: mode,
            label: `${settings.writingModes[mode].label} · ${settings.writingModes[mode].minOutputChars.toLocaleString()} 字`,
          }))}
        />
      </SettingRow>
      <SettingRow label="启用该档位" help="关闭后输入框里不再显示这个档位">
        <Switch
          label="启用该档位"
          checked={preset.enabled}
          onChange={(value) => update({ writingModes: { [modeTab]: { enabled: value } } })}
        />
      </SettingRow>
      <SettingRow
        label="字数下限"
        help="核心参数：本次生成至少要写到的字数。低于它时 Braid 会自动续写"
        hint={`按每轮约 4,800 字估算，约需 ${estimatedRounds(preset)} 轮请求`}
      >
        <NumberField
          value={preset.minOutputChars}
          min={500}
          max={2_000_000}
          step={500}
          onChange={(value) => update({ writingModes: { [modeTab]: { minOutputChars: value } } })}
          suffix="字"
          width={150}
        />
      </SettingRow>
      <SettingRow
        label="软上限系数"
        help={`达到「下限 × 该系数」即停止，防止模型跑飞。当前软上限 = ${softMaxOf(preset).toLocaleString()} 字`}
      >
        <Slider
          value={preset.softMaxRatio}
          min={1}
          max={2.5}
          step={0.05}
          onChange={(value) => update({ writingModes: { [modeTab]: { softMaxRatio: value } } })}
          format={(v) => `×${v.toFixed(2)}`}
        />
      </SettingRow>
      <SettingRow label="单轮输出上限" help="每次请求的 max_tokens，会被模型真实能力自动裁剪">
        <NumberField
          value={preset.maxTokensPerRequest}
          min={1024}
          max={65536}
          step={1024}
          onChange={(value) => update({ writingModes: { [modeTab]: { maxTokensPerRequest: value } } })}
          suffix="tok"
          width={150}
        />
      </SettingRow>
      <SettingRow label="续写方式" help="自动续写最省事；关闭即等于普通对话">
        <Segmented
          value={preset.continuation}
          onChange={(value) => update({ writingModes: { [modeTab]: { continuation: value } } })}
          options={[
            { value: 'auto', label: '自动续写' },
            { value: 'ask', label: '每轮询问' },
            { value: 'off', label: '关闭' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="空转上限"
        help="连续这么多轮没有产生新内容（模型原地打转）就中止，避免浪费 token"
      >
        <NumberField
          value={preset.stallLimit}
          min={1}
          max={10}
          step={1}
          onChange={(value) => update({ writingModes: { [modeTab]: { stallLimit: value } } })}
          suffix="轮"
          width={130}
        />
      </SettingRow>
      <SettingRow
        label="续写提示词"
        help="每轮续写时附带的指令，**短中长共用这一份**。防重复主要靠它，建议保留「不要重复已写内容」。它只发给模型，不会出现在对话里"
        stacked
      >
        <TextArea
          rows={2}
          value={settings.continuationPrompt}
          onChange={(value) => update({ continuationPrompt: value })}
        />
      </SettingRow>
    </SettingGroup>
  );
}
