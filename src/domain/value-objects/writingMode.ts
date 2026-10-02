/**
 * 小说模式（输出档位）
 *
 * 核心诉求：用户要求输出中长篇时，多数软件单次输出明显不够长。
 * 因此这里的本质是「**单次输出的最低字数下限**」——引擎会自动续写直到达标。
 *
 * 技术前提：单次 API 请求受 max_tokens 限制，一次能产出多少由**模型**决定
 *（早些年约 8K tokens ≈ 5k 汉字，现在几十万 token 的模型已经不罕见，界面上限据此放宽到 100 万）。
 * 字数超出单轮能力时就必须连续请求 —— 每次请求的上限是**全局共享**的
 * 「单轮输出上限」（`sampling.maxTokens`，界面在 设置 → 上下文 里），
 * 档位里不再各配一份：同一个"一次最多写多少"放在两个地方，用户只能猜哪个在生效。
 */

import { CHAR_TO_TOKEN_RATIO } from './usage';

export type WritingMode = 'short' | 'medium' | 'long';

export const WRITING_MODES: readonly WritingMode[] = ['short', 'medium', 'long'];

export interface WritingModePreset {
  mode: WritingMode;
  /** 显示名（可被用户改写，所以放在数据里而不是写死在 UI） */
  label: string;
  enabled: boolean;

  /** 【核心】单次输出的最低字数下限 */
  minOutputChars: number;
  /** 软上限系数：达到 minOutputChars × ratio 即停止，防止跑飞 */
  softMaxRatio: number;

  /** 续写方式：auto 自动 / ask 每轮询问 / off 关闭（等于普通对话） */
  continuation: 'auto' | 'ask' | 'off';
  /** 连续 N 轮无有效新增即中止（防"鬼打墙"） */
  stallLimit: number;
}

/**
 * 续写提示词（**全局共用一份**，不再按档位各配）
 *
 * 为什么从档位里提出来：它防的是"模型重复已写内容"这件事，
 * 而这件事与"这次要写多少字"无关 —— 短中长三个档位原本配的是同一句话，
 * 却要在三处各改一遍。防重复策略属于全局写作偏好，不属于某个长度档位。
 *
 * 会话级仍然可以单独覆盖（`conversation.continuationPrompt`）。
 *
 * 【当前这一版是用户自己写的，刻意从"约束"换成了"松绑"】
 * 上一版是四条硬约束（不要重复 / 不要元话语 / 保持人称时态密度 / 不要强行收尾）。
 * 实际上手后发现两个问题：模型在强约束下开始"跳过内容"——用一行一章的
 * 提要式写法往下推（不重复与不跳跃被一起执行了）；而且长约束本身会挤占
 * 注意力。所以现在只做一件事：**说明这条消息的来意**（是工具为了凑够
 * 单次输出量而补的，不是用户在催更），然后把创作空间还给模型。
 *
 * 【如果重复/离题又出现了，改这里，不要改代码】
 * 最有效的补丁是加回一句"不要复述已写内容"，或写清"接着最后一句往下写"。
 * 这几句话对成品质量的影响**远大于**任何参数调整，而且是用户当场可调的。
 */
export const DEFAULT_CONTINUATION_PROMPT = [
  '【工具系统指令：自动续写】',
  '这是我在工具预留的指令，我并不知道现在你写的情况怎么样了，写的内容如何，这只是为了让你一次性给用户输入足够多内容量而设定的指令，你无需在意，总之保持风格发挥想象来进行后续的创作吧，别被这段指令影响到后续创作。',
].join('\n');

export const DEFAULT_WRITING_MODES: Record<WritingMode, WritingModePreset> = {
  short: {
    mode: 'short',
    label: '短',
    enabled: true,
    minOutputChars: 4000,
    softMaxRatio: 1.3,
    continuation: 'off',
    stallLimit: 2,
  },
  medium: {
    mode: 'medium',
    label: '中',
    enabled: true,
    minOutputChars: 20000,
    softMaxRatio: 1.3,
    continuation: 'auto',
    stallLimit: 2,
  },
  long: {
    mode: 'long',
    label: '长',
    enabled: true,
    minOutputChars: 100000,
    softMaxRatio: 1.3,
    continuation: 'auto',
    stallLimit: 2,
  },
};

/** 软上限（= 下限 × 系数），超出即停止 */
export function softMaxOf(preset: WritingModePreset): number {
  return Math.round(preset.minOutputChars * preset.softMaxRatio);
}

/**
 * 单轮大约能产出多少汉字
 *
 * 参数是**生效的单轮输出上限**（`sampling.maxTokens`），不是某个档位 ——
 * 那个上限现在是全局共享的：普通对话与续写的每一轮都吃同一个值。
 *
 * 换算系数不在这里定义：它必须与上下文预算、成本预估共用同一处
 * （见 `usage.ts` 的 `CHAR_TO_TOKEN_RATIO`，那里写着"整个应用只有这一个地方定义换算系数"）。
 */
export function charsPerRoundOf(maxOutputTokens: number): number {
  return Math.max(1, Math.round(maxOutputTokens / CHAR_TO_TOKEN_RATIO.cjk));
}

/**
 * 预估需要多少次请求才能达到下限（用于界面提示"约需 20 轮"，避免用户以为一次就够）
 *
 * 【为什么不写死一个"每轮 4,800 字"】
 * 那是 `maxTokens = 8192` 时代的换算结果（8192 ÷ 1.7 ≈ 4,819）。输出上限放开到
 * 100 万 token 之后，用户完全可能填 384,000 —— 那时再按 4,800 字算，
 * 会把"1 轮"说成"约 80 轮"。而这个数字是用户判断"这一次要花多久、多少钱"的
 * 依据之一，不能建立在一个过期的假设上。
 */
export function estimatedRounds(preset: WritingModePreset, maxOutputTokens: number): number {
  if (preset.continuation === 'off') return 1;
  return Math.max(1, Math.ceil(preset.minOutputChars / charsPerRoundOf(maxOutputTokens)));
}
