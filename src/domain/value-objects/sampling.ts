/**
 * 采样参数（值对象）
 *
 * 全部字段可选：未设置的字段由 Provider 适配器决定是否下发，
 * 这样"用户没碰过的参数"不会污染请求、也不会破坏上游默认值。
 */
export interface SamplingParams {
  /** 0 – 2 */
  temperature?: number;
  /** 0 – 1 */
  topP?: number;
  maxTokens?: number;
  /** -2 – 2 */
  frequencyPenalty?: number;
  /** -2 – 2 */
  presencePenalty?: number;
  stop?: string[];
  seed?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export const SAMPLING_FIELDS = [
  'temperature',
  'topP',
  'maxTokens',
  'frequencyPenalty',
  'presencePenalty',
] as const;

export type SamplingField = (typeof SAMPLING_FIELDS)[number];

export const DEFAULT_SAMPLING_PARAMS: Required<
  Pick<SamplingParams, 'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty' | 'presencePenalty'>
> = {
  temperature: 1.0,
  topP: 1.0,
  maxTokens: 8192,
  frequencyPenalty: 0,
  presencePenalty: 0,
};

/**
 * 生效的单轮输出上限
 *
 * 未设置时退回默认值 —— 这个"退回哪"的规则只在这里写一次：
 * 它同时决定**请求参数**与**上下文预留**（预算 = 上下文长度 − 这个值），
 * 两处各写一遍迟早会不一致。
 */
export function effectiveMaxOutput(params: SamplingParams): number {
  return params.maxTokens ?? DEFAULT_SAMPLING_PARAMS.maxTokens;
}

/**
 * 单次输出上限的**天花板**（不是默认值）
 *
 * 【为什么从 65,536 放到 100 万】
 * 65,536 是好几年前的口径。现在动辄几十万输出 token 的模型已经不罕见
 *（deepseek-flash 给到 384,000），而这里卡在 65,536 时用户**连填都填不进去** ——
 * 他要写长文，唯一的办法就是把上限调大，结果发现输入框不让输。
 *
 * 上限放到与「上下文长度」同一量级（100 万），把"能填多少"这件事
 * 交回给用户：**具体发多少由他按自己模型的能力填**，Braid 不预设。
 * 默认值仍然是保守的（见 `DEFAULT_SAMPLING_PARAMS`）—— 默认给太大，
 * 碰上小窗口模型会直接被上游拒掉，那比"要自己调一次"糟得多。
 *
 * ⚠️ 这里**不会**帮用户按模型裁剪：Braid 不预设任何提供商，也就无从知道
 * 某个模型名的真实上限。填超了由上游报错，界面的提示已经写明这一点。
 */
export const MAX_OUTPUT_TOKENS_CEILING = 1_000_000;

/**
 * 每个参数的可调范围与步长，UI 据此渲染滑块，避免把约束散落在组件里。
 */
export const SAMPLING_CONSTRAINTS: Record<
  SamplingField,
  { min: number; max: number; step: number; label: string; hint: string }
> = {
  temperature: {
    min: 0,
    max: 2,
    step: 0.05,
    label: '温度',
    hint: 'temperature。越高越随机、越有创造力。写小说建议 1.2–1.5，写代码建议 0–0.3',
  },
  topP: {
    min: 0,
    max: 1,
    step: 0.01,
    label: 'Top P',
    hint: '核采样。与温度二选一调整即可，同时改容易失控',
  },
  maxTokens: {
    min: 256,
    max: MAX_OUTPUT_TOKENS_CEILING,
    step: 256,
    /*
     * 【它同时是"上下文预留"】见 02-domain.md 的预算公式
     *
     * 上下文预算 = 上下文长度 − 这里填的值。早先预算另有一个「为输出预留」设置项，
     * 结果是同一个意思要在两处填，还容易出现"预留 8k、上限填 384k"这种自相矛盾。
     * 现在留多少就由这一项决定 —— 界面在设置 → 上下文里展示它，因为只有在那里
     * 用户才看得懂"为什么要从窗口里扣掉一块"。
     */
    label: '单轮输出上限',
    hint: '一次请求最多输出多少 token（普通对话与续写每轮都用它）。按你所用模型的上限填，填超了上游会报错',
  },
  frequencyPenalty: {
    min: -2,
    max: 2,
    step: 0.1,
    label: '频率惩罚',
    hint: '正值可抑制重复用词',
  },
  presencePenalty: {
    min: -2,
    max: 2,
    step: 0.1,
    label: '存在惩罚',
    hint: '正值可鼓励模型引入新话题',
  },
};
