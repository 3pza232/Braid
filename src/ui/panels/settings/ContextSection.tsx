import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { MAX_OUTPUT_TOKENS_CEILING, effectiveMaxOutput } from '@domain/value-objects/sampling';
import { NumberField, Segmented, SettingGroup, SettingRow, Slider } from '@ui/primitives';

interface ContextSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/**
 * 上下文分区
 *
 * 【关于这里的 `help` 文案】一句能读懂的话，不写实现细节。
 * 早先这里写的是"超预算时按信息损失从小到大降级：先把过长的工具输出压成头+尾…"
 * 这类句子 —— 它解释的是代码，不是用户要做的决定（用户反馈："别写小作文"）。
 */
export function ContextSection({ settings, update }: ContextSectionProps) {
  return (
    <SettingGroup title="上下文" help="上下文不够用时的处理方式">
      <SettingRow label="上下文长度" help="按你所用模型的上下文窗口填，单位 token">
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
      {/*
        「单轮输出上限」放在这里，而不是「生成参数」里

        它是**上下文预算的另一半**：可用预算 = 上面的长度 − 这一项。
        两件事分在两个分区里，用户永远算不清"为什么预算比窗口小"。它的值是
        `sampling.maxTokens`（普通对话与短/中/长档位共享同一个），所以也仍然
        受「生成参数」那一层的会话/角色覆盖影响 —— 显示的是**生效值**。
      */}
      <SettingRow
        label="单轮输出上限"
        help="一次请求最多输出多少 token。它同时也是上下文的「输出预留」：填多大，预算就少多少"
      >
        <NumberField
          value={effectiveMaxOutput(settings.sampling)}
          min={256}
          max={MAX_OUTPUT_TOKENS_CEILING}
          step={256}
          onChange={(value) => update({ sampling: { maxTokens: value } })}
          suffix="tok"
          width={150}
        />
      </SettingRow>
      <SettingRow label="保留最近原文" help="压缩时至少保留最近多少轮的原文">
        <NumberField
          value={settings.context.keepRecentMessages}
          min={1}
          max={1000}
          step={1}
          onChange={(value) => update({ context: { keepRecentMessages: value } })}
          suffix="轮"
          width={140}
        />
      </SettingRow>
      <SettingRow
        label="上下文压缩"
        help="用量到触发线时，把最早的历史换成一段纪要。原文不会删除，仍可回看"
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
      <SettingRow label="压缩触发线" help="用量到这个比例就自动压缩">
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
