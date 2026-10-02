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
    max: 65536,
    step: 256,
    label: '单次最大输出',
    hint: '单次请求的输出 token 上限，会被模型真实能力裁剪。要写超长内容请用「续写模式」的字数下限',
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
