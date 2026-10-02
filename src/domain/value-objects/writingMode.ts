/**
 * 小说模式（输出档位）
 *
 * 核心诉求：用户要求输出中长篇时，多数软件单次输出明显不够长。
 * 因此这里的本质是「**单次输出的最低字数下限**」——引擎会自动续写直到达标。
 *
 * 技术前提：单次 API 请求受 max_tokens 硬限制（DeepSeek 约 8K tokens ≈ 5–6k 汉字），
 * 所以 100k 字必须约 20 次连续请求。`maxTokensPerRequest` 就是每次请求的上限。
 */

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
  /** 单次请求的 max_tokens（会被模型能力裁剪） */
  maxTokensPerRequest: number;

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
 * 【这条词在防什么】
 * 多轮续写最大的质量杀手不是"写不长"，而是**衔接处的三类污染**：
 *  1. 复述前文（模型把上一轮结尾再说一遍，正文出现大段重复）；
 *  2. 元话语（"好的，我继续""以下是接下来的内容"—— 对话腔混进正文）；
 *  3. 收束冲动（模型以为该收尾了，草草结束，下一轮又被迫"重新展开"）。
 * 所以这里明确告诉它三件事：**为什么会被截断**（是工具的分批机制，不是写完了）、
 * **从哪里接着写**（截断处的下一个字，无缝衔接）、**怎么写**（同人称同时态同密度）。
 */
export const DEFAULT_CONTINUATION_PROMPT = [
  '【系统指令：自动续写】',
  '上文因单次回复的输出长度上限而被截断，这是本工具的分批生成机制，并不代表内容已经写完。请从中断处无缝衔接，直接继续写下一个字。',
  '要求：',
  '1. 不要重复、复述或改写上文已出现的任何内容；',
  '2. 不要任何元话语（如"好的""接下来""以下是"），不要重新开场，不要总结前文，直接进入正文；',
  '3. 严格保持与前文一致的人称、时态、文风、叙事节奏与信息密度，按前文的 granularity 继续展开，不要跳跃时间线；',
  '4. 不要在此轮强行收尾 —— 是否结束由整体进度决定，你只需按同样的密度自然推进。',
].join('\n');

export const DEFAULT_WRITING_MODES: Record<WritingMode, WritingModePreset> = {
  short: {
    mode: 'short',
    label: '短',
    enabled: true,
    minOutputChars: 4000,
    softMaxRatio: 1.3,
    maxTokensPerRequest: 8192,
    continuation: 'off',
    stallLimit: 2,
  },
  medium: {
    mode: 'medium',
    label: '中',
    enabled: true,
    minOutputChars: 20000,
    softMaxRatio: 1.3,
    maxTokensPerRequest: 8192,
    continuation: 'auto',
    stallLimit: 2,
  },
  long: {
    mode: 'long',
    label: '长',
    enabled: true,
    minOutputChars: 100000,
    softMaxRatio: 1.3,
    maxTokensPerRequest: 8192,
    continuation: 'auto',
    stallLimit: 2,
  },
};

/** 软上限（= 下限 × 系数），超出即停止 */
export function softMaxOf(preset: WritingModePreset): number {
  return Math.round(preset.minOutputChars * preset.softMaxRatio);
}

/** 预估需要多少次请求才能达到下限（用于 UI 提示"约需 20 轮"，避免用户误以为一次就够） */
export function estimatedRounds(preset: WritingModePreset, charsPerRequest = 4800): number {
  if (preset.continuation === 'off') return 1;
  return Math.max(1, Math.ceil(preset.minOutputChars / charsPerRequest));
}
