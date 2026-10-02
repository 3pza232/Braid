import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { effectiveMaxOutput } from '@domain/value-objects/sampling';
import {
  WRITING_MODES,
  charsPerRoundOf,
  estimatedRounds,
  softMaxOf,
  type WritingMode,
} from '@domain/value-objects/writingMode';
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
 * `modeTab` 与 `preset` 由面板传进来而不是在这里自己算：档位切换要同时影响
 * 别的地方（面板里还有别的分区读它），状态留在上层才是单一来源。
 *
 * 【`help` 只写"这个参数管什么"】早先几条写成了机制说明（"软上限是到此为止的边界，
 * 避免为凑字数跑飞；停顿检测在连续几轮…"）—— 用户不需要看懂实现，只需要知道
 * 调大调小会怎样（用户反馈："别写小作文"）。
 */
export function WritingSection({
  settings,
  update,
  modeTab,
  onModeTabChange,
  preset,
}: WritingSectionProps) {
  // 每轮能写多少由全局共享的「单轮输出上限」决定（见 设置 → 上下文），档位里不再各配一份
  const maxOutputTokens = effectiveMaxOutput(settings.sampling);
  return (
    <SettingGroup title="续写模式" help="写长文时的自动续写规则，按档位分别设置">
      <SettingRow label="默认档位" help="新建会话时用哪个档位">
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
      <SettingRow label="启用该档位" help="关掉后输入框里不再显示这个档位">
        <Switch
          label="启用该档位"
          checked={preset.enabled}
          onChange={(value) => update({ writingModes: { [modeTab]: { enabled: value } } })}
        />
      </SettingRow>
      <SettingRow
        label="字数下限"
        help="至少要写到的字数，不到就自动接着写"
        hint={`每轮约 ${charsPerRoundOf(maxOutputTokens).toLocaleString()} 字（受「单轮输出上限」影响），约需 ${estimatedRounds(preset, maxOutputTokens)} 轮请求`}
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
        help={`达到「下限 × 系数」就停。当前 = ${softMaxOf(preset).toLocaleString()} 字`}
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
      {/* 「单轮输出上限」不在这里：它移到 设置 → 上下文，短/中/长与普通对话共享同一个值 */}
      <SettingRow
        label="续写方式"
        help="自动：自己接着写。每轮询问：每轮写完停下等你点「继续写」"
      >
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
      <SettingRow label="空转上限" help="连续这么多轮没有新内容就中止">
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
        help="每轮续写时附在请求里的指令，不会出现在对话里"
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
