import type { AvatarRef } from './avatar';
import { DEFAULT_ASSISTANT_AVATAR, DEFAULT_USER_AVATAR } from './avatar';
import type { SamplingParams } from './sampling';
import { DEFAULT_SAMPLING_PARAMS } from './sampling';
import type { WritingMode, WritingModePreset } from './writingMode';
import { DEFAULT_CONTINUATION_PROMPT, DEFAULT_WRITING_MODES } from './writingMode';

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;

/**
 * 模型名长度上限
 *
 * 真实模型名都很短（`gpt-4o-mini` 这种），160 只是防"整段说明粘进名字框" ——
 * 它会出现在顶栏那个徽标里，超长会把顶栏顶变形。
 */
export const MAX_MODEL_NAME_LENGTH = 160;

/**
 * 模型与凭据
 *
 * 【重要设计原则】Braid **不预设任何模型提供商，也不替用户选模型**。
 * 这里全部是用户自己填的文本，原样拼进请求：
 *   - `model`    → 请求体的 `model` 字段（如 'deepseek-v4-flash'、'gpt-4o'、'qwen-max'）
 *   - `baseUrl`  → OpenAI 兼容端点
 * 因为对接方是"喜欢极致定制化"的用户，任何白名单都只会成为阻碍。
 */
/**
 * 一份「模型配置」
 *
 * 「什么端点 + 什么凭据 + 什么模型名 + 怎么查余额」是**一件事**：
 * 换端点就必然换 Key、也可能换余额接口。所以它们打包在一个配置里，
 * 而不是让用户在三个不同的设置页里对账。
 */
export interface ModelProfile {
  id: string;
  /** 显示名，用于在会话里挑选，例如「DeepSeek 官网」 */
  name: string;
  /** 模型名，原样作为请求的 model 字段 */
  model: string;
  baseUrl: string;
  /** 手填的 Key。是否落盘由 persistApiKey 决定 */
  apiKey: string;
  /**
   * 是否把 Key 存到本地
   *
   * 默认 **false**（只在内存驻留，关掉应用就要重填）。
   * 打开后写入本机数据库 —— 注意：**是明文**，能读到这台电脑文件的人就能看到它。
   * 默认关着，等用户自己确认"这台机器只有我用"。
   */
  persistApiKey: boolean;
  requestTimeoutMs: number;
  extraBody: string;
  /** 余额查询配置：不同端点的余额接口完全不同，所以跟配置走 */
  balance: BalanceSettings;
}

export interface ModelSettings {
  profiles: ModelProfile[];
  /** 当前默认使用哪一份配置 */
  activeProfileId: string;
}

/** 身份设置：AI 与用户怎么互相称呼、长什么样 */
export interface IdentitySettings {
  /** 用户的名字，宏 {{user}} */
  userName: string;
  /** AI 的名字，宏 {{char}} */
  assistantName: string;
  userAvatar: AvatarRef;
  assistantAvatar: AvatarRef;
}

/**
 * 上下文策略
 *
 * 默认 1,000,000 是**用户可改的默认值**，不是硬上限。
 * 真正可用的预算 = 这个值 − **单轮输出上限**（`sampling.maxTokens`）——
 * 留给输出的那一块不再单独配一遍：同一个意思填两个地方，迟早会出现
 * "预留 8k、上限却填了 384k"这种自相矛盾（见 `sampling.ts` 里 maxTokens 的说明）。
 */
export interface ContextSettings {
  maxContextTokens: number;
  /** 至少保留最近多少**轮**原文（一轮 = 一问一答，含其间的工具往来） */
  keepRecentMessages: number;
  /**
   * 上下文压缩（compaction）
   *
   *  - `auto`：用量涨到触发线时**静默压缩** —— 把最早的历史改写成一段纪要，
   *    信息不丢、篇幅变短。压过哪些内容可以在顶栏的上下文菜单里回看；
   *  - `off` ：绝不自动改写历史。真的超出上限时**拦住发送**，
   *    由用户自己决定压不压 —— 因为压缩要花一次模型调用，且会改写发送内容，
   *    这两件事都不该在"关掉自动"之后还悄悄发生。
   *
   * **没有"丢弃最早"这一档**：丢历史等价于让模型失忆，省下的 token 却和压缩差不多。
   * 既然要做，就只做信息保留的那一种。
   */
  compression: 'auto' | 'off';
  /** 触发压缩的用量比例（0–1）。默认 0.85：留出一段缓冲，别等到贴边才动 */
  compressAt: number;
}

/** 消息信息栏里可显示的字段 */
export type MetaFieldId = 'model' | 'temperature' | 'tokens' | 'cache' | 'time';

export interface MetaFieldSettings {
  id: MetaFieldId;
  enabled: boolean;
}

/** 全部可显示字段的**权威清单**（也决定新增字段时的默认落位） */
export const META_FIELD_IDS: readonly MetaFieldId[] = [
  'model',
  'temperature',
  'tokens',
  'cache',
  'time',
];

export const META_FIELD_LABELS: Record<MetaFieldId, string> = {
  model: '模型',
  temperature: '温度',
  tokens: 'token 用量',
  cache: '缓存命中率',
  time: '时间',
};

/**
 * 消息信息栏设置
 *
 * 用「**有序数组 + enabled**」而不是一组独立布尔开关：
 * 顺序本身也是用户要定制的东西，拆成"开关表 + 顺序表"两份数据迟早会不一致。
 */
export interface MessageDisplaySettings {
  /** 数组顺序 = 显示顺序（界面可拖动调整） */
  metaFields: MetaFieldSettings[];
  actionBarTrigger: 'hover' | 'always';
  /**
   * 是否显示"过程"：模型的思考链路 **+ 文件工具的执行过程**
   *
   * 【字段名保留 `showReasoning` 不改，是为了避免一次设置迁移】它现在管两件事，
   * 但改名要动 schema 版本与归一化，而它只是一个布尔 —— 那个代价不值。
   * 关掉后两者都只是**不展示**：思考文本与工具结果仍然完整保存，
   * 导出与数据库里都在（与"关掉只是不显示"的既有语义一致）。
   */
  showReasoning: boolean;
  /** 思考链路的初始展开状态（用户点过之后以用户的选择为准） */
  reasoningDefaultExpanded: boolean;
  /**
   * 「工具使用过程默认展开」
   *
   * 与「思考过程默认展开」对称：开了就常展开、**不随阶段折叠**。
   * 默认关 = 跟随阶段（执行工具时展开、一开始说正文就折叠）。
   */
  toolsDefaultExpanded: boolean;
  /**
   * 跟随过程自动展开（总开关，默认开）
   *
   * 开：生成过程中自动展开对应的过程面板 —— 思考时展开思考框、执行工具时展开工具框，
   * 一开始说正文就两个都折叠；中途再思考 / 再调用工具就再展开（按轮判断）。
   * 关：两块面板都不再自动开合，打开与关闭只由用户自己点。
   *
   * **只管正在生成的那条**：历史消息一律默认收起 —— 否则翻旧对话时每条老消息的
   * 展开状态都不一样，版面会很跳。
   */
  followProgress: boolean;
}

/**
 * 归一化字段列表：补齐缺失项、丢弃未知项、去重
 *
 * 为什么必须归一化而不是直接用存下来的数组：
 * 用户在旧版本里存的列表不含后来新增的字段，直接采用会导致**新字段永远不出现**；
 * 反过来，被删掉的字段 id 留在数据里会让界面渲染出空白项。
 */
export function normalizeMetaFields(
  incoming: readonly MetaFieldSettings[] | undefined,
  fallback: readonly MetaFieldSettings[],
): MetaFieldSettings[] {
  const known = new Set<MetaFieldId>(META_FIELD_IDS);
  const seen = new Set<MetaFieldId>();
  const out: MetaFieldSettings[] = [];

  for (const item of incoming ?? []) {
    if (!item || !known.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, enabled: item.enabled !== false });
  }

  // 老数据里没有的字段追加到末尾，取默认值（新增字段能自然融入）
  for (const item of fallback) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ ...item });
  }

  return out;
}

/** 拖动排序：把 from 位置的项移到 to 位置 */
export function reorderMetaFields(
  fields: readonly MetaFieldSettings[],
  from: number,
  to: number,
): MetaFieldSettings[] {
  if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) {
    return [...fields];
  }
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...fields];
  next.splice(to, 0, moved);
  return next;
}

export interface AppearanceSettings {
  contentFontSize: 'sm' | 'base' | 'lg';
  /** 消息区最大宽度（px） */
  contentMaxWidth: number;
  messageDensity: 'compact' | 'comfortable';
  /** 气泡式：左右分栏气泡；纯文本式：适合长文写作阅读 */
  bubbleStyle: 'bubble' | 'plain';
  showAvatars: boolean;
  reduceMotion: boolean;
  /** 自定义强调色；空字符串 = 跟随主题 */
  accentColor: string;
  /** 语义颜色的逐项覆盖（key = 主题 token 路径），见 ThemeColors 面板 */
  customColors: Record<string, string>;
}

export interface ComposerSettings {
  sendShortcut: 'enter' | 'ctrlEnter';
  /**
   * 输入框自适应的最大高度（px）
   *
   * 输入框随内容长高，长到这个值就内部滚动。
   * 写长文的人会想要更大的输入区，但也不能把消息区整个顶没 —— 所以可调。
   */
  maxInputHeight: number;
}

/**
 * 余额显示
 *
 * 核心是 `script`：一段**由用户自己编写**的 JS，负责"请求哪个地址 + 怎么解析响应"。
 * Braid 不内置任何厂商的余额接口，因此这里默认是空的（不显示余额）。
 * 脚本里可用 {{apiKey}} / {{baseUrl}} 占位，避免把密钥写死进脚本文本。
 */
export interface BalanceSettings {
  script: string;
  autoRefresh: boolean;
  refreshIntervalMs: number;
}

export interface AppSettings {
  schemaVersion: number;
  /** 模型配置列表（含凭据与余额），不再有独立的「余额设置」页 */
  model: ModelSettings;
  identity: IdentitySettings;
  /** 全局默认采样参数（三层优先级的最底层） */
  sampling: SamplingParams;
  context: ContextSettings;
  /** 短 / 中 / 长 三档输出下限，全部可调 */
  writingModes: Record<WritingMode, WritingModePreset>;
  /** 新建会话默认使用的输出档位 */
  defaultWritingMode: WritingMode | 'chat';
  /**
   * 续写提示词（**全局共用一份**，不再按档位各配 —— 理由见 writingMode.ts）
   *
   * 会话级可用 `conversation.continuationPrompt` 覆盖。
   */
  continuationPrompt: string;
  messageDisplay: MessageDisplaySettings;
  appearance: AppearanceSettings;
  composer: ComposerSettings;
}

/* ────────────────────────── 模型配置的读写辅助 ────────────────────────── */

export function createModelProfile(init: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: init.id ?? `mp-${Math.random().toString(36).slice(2, 10)}`,
    name: init.name ?? '新配置',
    model: init.model ?? '',
    baseUrl: init.baseUrl ?? '',
    apiKey: init.apiKey ?? '',
    persistApiKey: init.persistApiKey ?? false,
    requestTimeoutMs: init.requestTimeoutMs ?? 120_000,
    extraBody: init.extraBody ?? '',
    balance: {
      script: init.balance?.script ?? '',
      autoRefresh: init.balance?.autoRefresh ?? false,
      refreshIntervalMs: init.balance?.refreshIntervalMs ?? 60_000,
    },
  };
}

/** 当前生效的配置（列表为空或 id 失效时回落到第一条，保证总有东西可用） */
export function activeProfileOf(settings: AppSettings): ModelProfile | null {
  const { profiles, activeProfileId } = settings.model;
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
}

export function profileById(settings: AppSettings, id: string | null | undefined): ModelProfile | null {
  if (!id) return null;
  return settings.model.profiles.find((profile) => profile.id === id) ?? null;
}

/** 按 id 归并配置列表：补齐缺失项、丢弃未知项 —— 与 metaFields 同一套纪律 */
export function normalizeProfiles(
  incoming: readonly ModelProfile[] | undefined,
  fallback: readonly ModelProfile[],
): ModelProfile[] {
  if (!incoming) return fallback.map((profile) => ({ ...profile }));
  const seen = new Set<string>();
  const out: ModelProfile[] = [];
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(createModelProfile(item));
  }
  return out;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  model: {
    // 出厂不预设任何厂商的地址/模型名，只给一个空壳让用户自己填
    profiles: [createModelProfile({ id: 'default', name: '默认配置' })],
    activeProfileId: 'default',
  },
  identity: {
    userName: '我',
    assistantName: 'AI',
    userAvatar: DEFAULT_USER_AVATAR,
    assistantAvatar: DEFAULT_ASSISTANT_AVATAR,
  },
  sampling: { ...DEFAULT_SAMPLING_PARAMS },
  context: {
    maxContextTokens: 1_000_000,

    keepRecentMessages: 6,
    compression: 'auto',
    compressAt: 0.85,
  },
  writingModes: structuredClone(DEFAULT_WRITING_MODES),
  defaultWritingMode: 'chat',
  continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
  messageDisplay: {
    metaFields: [
      { id: 'model', enabled: true },
      { id: 'temperature', enabled: true },
      { id: 'tokens', enabled: true },
      { id: 'cache', enabled: true },
      { id: 'time', enabled: false },
    ],
    actionBarTrigger: 'hover',
    showReasoning: true,
    reasoningDefaultExpanded: false,
    // 默认关 = 跟随阶段（执行工具时展开、开始说正文就折叠）。
    // 打开它等于"我就是要一直看着工具在干什么"，那时不再和阶段较劲
    toolsDefaultExpanded: false,
    // 默认跟随：这是"看得见它在干什么"的那条路径，关掉反而失去了过程可见性
    followProgress: true,
  },
  appearance: {
    contentFontSize: 'base',
    contentMaxWidth: 820,
    messageDensity: 'comfortable',
    bubbleStyle: 'bubble',
    showAvatars: true,
    reduceMotion: false,
    accentColor: '',
    /**
     * 用户对**语义颜色**的逐项覆盖
     *
     * key 是主题 token 的路径（如 `role.userBubble`、`accent.default`），
     * value 是任意 CSS 颜色值。它应用在主题**之上**：
     * 换主题不会清掉它，想回到主题默认值就把对应项删掉。
     * 设置界面里每一项都能单独重置 —— 见 ThemeColors 面板。
     */
    customColors: {},
  },
  composer: {
    sendShortcut: 'enter',
    maxInputHeight: 260,
  },
};

/** 一层局部更新（每个分组内部按字段合并） */
export type AppSettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K];
};

/**
 * 按 base 的键集合并，**忽略 patch 里 base 没有的键**
 *
 * 不用 `{...base, ...patch}` 是因为那样会把旧版本或外部文件里的未知字段
 * 原样带进内存并在下次保存时写回，形成"垃圾字段越滚越多"。
 */
function pickGroup<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(base)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function mergeAppSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  const writingModes = { ...base.writingModes };
  if (patch.writingModes) {
    for (const mode of Object.keys(base.writingModes) as WritingMode[]) {
      const incoming = patch.writingModes[mode];
      if (incoming) writingModes[mode] = pickGroup(base.writingModes[mode], incoming);
    }
  }

  const messageDisplay = pickGroup(base.messageDisplay, patch.messageDisplay);
  const model = pickGroup(base.model, patch.model);
  // 只算一次：下面要同时用它做"列表内容"与"选中项是否还存在"两件事，
  // 各算各的话将来改漏一处就会出现"校验用的列表和实际存的列表不一致"
  const profiles = normalizeProfiles(patch.model?.profiles, base.model.profiles);

  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    model: {
      ...model,
      profiles,
      // 选中的那条配置可能已经被删掉，回落到第一条，保证"总有东西可用"
      activeProfileId: profiles.some((profile) => profile.id === model.activeProfileId)
        ? model.activeProfileId
        : (base.model.profiles[0]?.id ?? ''),
    },
    identity: pickGroup(base.identity, patch.identity),
    sampling: pickGroup(base.sampling, patch.sampling),
    context: pickGroup(base.context, patch.context),
    // metaFields 需要按 id 归并：pickGroup 是整组替换，直接用它会让
    // 旧数据里缺失的新字段永远不出现，或被删掉的字段留下空白项
    messageDisplay: {
      ...messageDisplay,
      metaFields: normalizeMetaFields(patch.messageDisplay?.metaFields, base.messageDisplay.metaFields),
    },
    appearance: pickGroup(base.appearance, patch.appearance),
    composer: pickGroup(base.composer, patch.composer),
    writingModes,
    defaultWritingMode: patch.defaultWritingMode ?? base.defaultWritingMode,
    continuationPrompt: patch.continuationPrompt ?? base.continuationPrompt,
  };
}

/** 从任意外部数据里挑出已知形状（旧版本落盘、导入的文件） */
export function pickSettingsShape(raw: unknown): AppSettingsPatch {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(DEFAULT_APP_SETTINGS)) {
    if (key === 'schemaVersion') continue;
    const value = source[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') patch[key] = value;
    else patch[key] = value;
  }

  return patch as AppSettingsPatch;
}

/** 落盘前的净化：**API Key 永不出现在持久化数据里**（ADR-020） */
export function toPersistableSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    model: {
      ...settings.model,
      /*
       * 凭据落盘策略
       *
       * 默认**擦掉** Key（只留内存，关掉应用就要重填）——
       * 因为它是明文存在本机数据库里的，能读到这台电脑文件的人就能看到。
       * 用户在某个配置上显式勾了「保存到本地」才写进去（浏览器端没有环境变量可用，
       * 每次都重填实在难用，所以给一个明确开关而不是替他决定）。
       */
      profiles: settings.model.profiles.map((profile) => ({
        ...profile,
        apiKey: profile.persistApiKey ? profile.apiKey : '',
      })),
    },
  };
}
