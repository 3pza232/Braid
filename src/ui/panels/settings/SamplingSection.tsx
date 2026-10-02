import { SAMPLING_CONSTRAINTS } from '@domain/value-objects/sampling';
import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { SettingGroup, SettingRow, Slider } from '@ui/primitives';

/**
 * 用滑块调的四个参数
 *
 * `maxTokens`（单轮输出上限）**不在这里**：它同时决定上下文预算里"留给输出的那一块"，
 * 所以界面上归到「上下文」分区 —— 只有在那里用户才看得懂为什么要从窗口里扣掉一块。
 * 字段本身仍是采样参数（`settings.sampling.maxTokens`），会话/角色照样可以覆盖。
 */
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
    </SettingGroup>
  );
}
