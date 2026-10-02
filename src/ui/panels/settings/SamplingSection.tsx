import { SAMPLING_CONSTRAINTS } from '@domain/value-objects/sampling';
import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { NumberField, SettingGroup, SettingRow, Slider } from '@ui/primitives';

/** 用滑块调的四个参数（`maxTokens` 是数字输入，单独一行） */
const SLIDER_KEYS = ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'] as const;

interface SamplingSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/**
 * 生成参数（全局默认）
 *
 * 从 `SettingsPanel` 里搬出来的第一个分区。搬它的原则：**只搬家，不改语义** ——
 * JSX、类名、取值方式一模一样，只是把 `settings` / `update` 换成 props。
 * 这类重构最容易出的错不是逻辑错，而是"漏传一个东西"，所以配合面板的冒烟测试
 * （每个分区都渲染一遍）来验证，而不是靠通读。
 */
export function SamplingSection({ settings, update }: SamplingSectionProps) {
  return (
    <SettingGroup title="生成参数（全局默认）">
      {SLIDER_KEYS.map((key) => {
        const constraint = SAMPLING_CONSTRAINTS[key];
        return (
          <SettingRow key={key} label={constraint.label} help={constraint.hint}>
            <Slider
              value={settings.sampling[key] ?? 0}
              min={constraint.min}
              max={constraint.max}
              step={constraint.step}
              onChange={(next) => update({ sampling: { [key]: next } })}
              format={(v) => v.toFixed(2)}
            />
          </SettingRow>
        );
      })}
      <SettingRow
        label={SAMPLING_CONSTRAINTS.maxTokens.label}
        help={SAMPLING_CONSTRAINTS.maxTokens.hint}
      >
        <NumberField
          value={settings.sampling.maxTokens ?? 8192}
          min={256}
          max={65536}
          step={256}
          onChange={(value) => update({ sampling: { maxTokens: value } })}
          suffix="tok"
          width={140}
        />
      </SettingRow>
    </SettingGroup>
  );
}
