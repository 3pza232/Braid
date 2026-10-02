import type { Conversation } from '@domain/entities/conversation';
import type { AppSettings, ModelProfile } from '@domain/value-objects/appSettings';
import { activeProfileOf, profileById } from '@domain/value-objects/appSettings';
import type { AvatarRef } from '@domain/value-objects/avatar';
import { DEFAULT_ASSISTANT_AVATAR, DEFAULT_USER_AVATAR } from '@domain/value-objects/avatar';
import type { SamplingParams } from '@domain/value-objects/sampling';
import { softMaxOf, type WritingMode } from '@domain/value-objects/writingMode';

/**
 * 两层配置解析
 *
 *   ┌──────────────┐      ┌────────────────────┐      ┌────────────────┐
 *   │ 全局默认      │ ───► │ 角色实例            │ ───► │ 会话覆盖        │
 *   │ AppSettings  │      │ conversation.       │      │ Conversation   │
 *   │              │      │ roleInstance（只读） │      │                │
 *   └──────────────┘      └────────────────────┘      └────────────────┘
 *             ↑
 *   角色预设（预制体）只在"创建会话"或"重新同步"时被快照成实例，
 *   因此编辑角色预设**不会**影响已开始的对话。
 *
 * 规则：后一层只覆盖它显式写过的字段（null / 空 = 继承）。
 * 本文件是这件事的**唯一实现**：UI、上下文构建、请求组装都调它，不可能各算各的。
 */
export interface ResolvedIdentity {
  userName: string;
  assistantName: string;
  userAvatar: AvatarRef;
  assistantAvatar: AvatarRef;
}

export type Layer = 'global' | 'role' | 'conversation';

export interface ResolvedConfig {
  /** 最终用于请求的模型名（可能为空 = 尚未配置） */
  model: string;
  /**
   * 最终生效的「模型配置」（端点 / 凭据 / 余额脚本）
   *
   * 与 `model` 分开：配置决定打到哪、用哪个 Key；`model` 是可选的模型名覆盖。
   * 三份里都没配置时为 null，界面据此提示"去添加一个模型配置"。
   */
  profile: ModelProfile | null;
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  extraBody: string;

  params: SamplingParams;
  systemPrompt: string;
  writingMode: WritingMode | 'chat';
  /** 续写模式：本次至少要写到的字数 */
  minOutputChars: number;
  /** 续写模式：每轮续写时附带的指令 */
  continuationPrompt: string;
  /** 单次请求的 max_tokens（续写档位专用；普通对话用 `params.maxTokens`） */
  maxTokensPerRequest: number;
  /** 软上限（字数）＝ 下限 × 系数。达到即停，防止为凑字数跑飞 */
  softMaxChars: number;
  /** 连续 N 轮没有新增内容就中止（防"鬼打墙"） */
  stallLimit: number;
  /** 续写方式：auto 自动 / ask 每轮询问 / off 关闭 */
  continuation: 'auto' | 'ask' | 'off';

  maxContextTokens: number;
  reservedForOutput: number;
  /** 可用上下文预算 = 上限 − 输出预留；<= 0 表示没有预算信息（不压缩） */
  contextBudget: number;
  /** 至少保留最近多少轮原文（一轮 = 一问一答） */
  keepRecentTurns: number;
  /** 达到多少比例就触发压缩（0–1） */
  compressAt: number;
  /** `auto` = 到线静默压缩；`off` = 绝不自动改写，超限时拦住发送 */
  compression: 'auto' | 'off';

  identity: ResolvedIdentity;
  variables: Record<string, string>;

  /** 每个字段的来源，供界面标注「继承中 / 已覆盖」 */
  sources: {
    profile: Layer;
    model: Layer;
    systemPrompt: Layer;
    writingMode: Layer;
    keepRecentTurns: Layer;
    params: Layer;
    identity: Layer;
  };
}

function mergeParams(...layers: Array<SamplingParams | undefined>): SamplingParams {
  const out: SamplingParams = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function hasAnyParam(params: SamplingParams | undefined): boolean {
  if (!params) return false;
  return Object.values(params).some((value) => value !== undefined);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().length > 0 ? value : null;
}

export function resolveConfig(settings: AppSettings, conversation: Conversation | null): ResolvedConfig {
  const instance = conversation?.roleInstance ?? null;

  // ── 模型配置：会话 → 角色实例 → 全局当前 ──
  const profile =
    profileById(settings, conversation?.modelProfileId) ??
    profileById(settings, instance?.modelProfileId) ??
    activeProfileOf(settings);
  const profileSource: Layer =
    conversation?.modelProfileId ? 'conversation' : instance?.modelProfileId ? 'role' : 'global';

  // ── 模型名：会话覆盖 > 角色覆盖 > 配置里写的那一个 ──
  const conversationModel = nonEmpty(conversation?.model);
  const instanceModel = nonEmpty(instance?.model);
  const profileModel = nonEmpty(profile?.model);
  const model = conversationModel ?? instanceModel ?? profileModel ?? '';
  const modelSource: Layer = conversationModel
    ? 'conversation'
    : instanceModel
      ? 'role'
      : 'global';

  // ── 系统提示词 ──
  const conversationPrompt = nonEmpty(conversation?.systemPrompt);
  const instancePrompt = nonEmpty(instance?.systemPrompt);
  const systemPrompt = conversationPrompt ?? instancePrompt ?? '';
  const promptSource: Layer = conversationPrompt ? 'conversation' : instancePrompt ? 'role' : 'global';

  // ── 输出档位 ──
  const conversationMode = conversation && conversation.writingMode !== 'chat' ? conversation.writingMode : null;
  const instanceMode = instance?.writingMode && instance.writingMode !== 'chat' ? instance.writingMode : null;
  const globalMode = settings.defaultWritingMode !== 'chat' ? settings.defaultWritingMode : null;
  const writingMode: WritingMode | 'chat' = conversationMode ?? instanceMode ?? globalMode ?? 'chat';
  const modeSource: Layer = conversationMode ? 'conversation' : instanceMode ? 'role' : 'global';

  // ── 档位细节（字数下限 / 续写提示词）：会话覆盖 > 该档位的全局预设 ──
  const modePreset = settings.writingModes[writingMode === 'chat' ? 'short' : writingMode];
  const minOutputChars = conversation?.minOutputChars ?? modePreset.minOutputChars;
  // 续写提示词现在是**全局共用一份**（不再按档位各配），会话仍可覆盖
  const continuationPrompt = nonEmpty(conversation?.continuationPrompt) ?? settings.continuationPrompt;

  // ── 上下文 ──
  // 上限只有全局一层：它是"这份配置给模型留了多大窗口"的性质，按会话改没有正当用途
  const maxContextTokens = settings.context.maxContextTokens;
  // 预算在这里算好，压缩引擎不再自己去翻设置 —— 与续写引擎同一条纪律
  const contextBudget = Math.max(0, maxContextTokens - settings.context.reservedForOutput);
  const conversationKeep = conversation?.keepRecentMessages ?? null;
  const keepRecentTurns = conversationKeep ?? settings.context.keepRecentMessages;
  const keepSource: Layer = conversationKeep !== null ? 'conversation' : 'global';

  // ── 采样参数 ──
  const params = mergeParams(settings.sampling, instance?.params, conversation?.params);
  const paramsSource: Layer =
    hasAnyParam(conversation?.params) ? 'conversation' : hasAnyParam(instance?.params) ? 'role' : 'global';

  // ── 身份：会话覆盖 > 角色实例 > 全局 ──
  const conversationAssistantName = nonEmpty(conversation?.assistantName);
  const conversationUserName = nonEmpty(conversation?.userName);
  const instanceAssistantName = nonEmpty(instance?.assistantName);
  const instanceUserName = nonEmpty(instance?.userName);

  const identity: ResolvedIdentity = {
    userName: conversationUserName ?? instanceUserName ?? settings.identity.userName,
    assistantName: conversationAssistantName ?? instanceAssistantName ?? settings.identity.assistantName,
    userAvatar: settings.identity.userAvatar ?? DEFAULT_USER_AVATAR,
    assistantAvatar: instance?.avatar ?? settings.identity.assistantAvatar ?? DEFAULT_ASSISTANT_AVATAR,
  };
  const identitySource: Layer =
    conversationAssistantName || conversationUserName
      ? 'conversation'
      : instanceAssistantName || instanceUserName
        ? 'role'
        : 'global';

  // ── 宏变量 ──
  const variables: Record<string, string> = {
    user: identity.userName,
    char: identity.assistantName,
    writing_mode: writingMode === 'chat' ? '普通对话' : writingMode,
    ...(instance?.variables ?? {}),
  };

  return {
    model,
    profile,
    baseUrl: profile?.baseUrl ?? '',
    apiKey: profile?.apiKey ?? '',
    requestTimeoutMs: profile?.requestTimeoutMs ?? 120_000,
    extraBody: profile?.extraBody ?? '',
    params,
    systemPrompt,
    writingMode,
    minOutputChars,
    continuationPrompt,
    /*
     * 下面四个是**续写引擎的唯一输入源**
     *
     * 之前引擎要自己去翻 `settings.writingModes[mode]`，那会破坏
     * resolveConfig 声明的"分层解析只在这里做一次"—— 也会让
     * "会话覆盖是否生效"出现两套判断。全部在这里解析好，引擎只吃这份快照。
     */
    maxTokensPerRequest: modePreset.maxTokensPerRequest,
    softMaxChars: softMaxOf(modePreset),
    stallLimit: modePreset.stallLimit,
    continuation: modePreset.continuation,
    maxContextTokens,
    reservedForOutput: settings.context.reservedForOutput,
    contextBudget,
    keepRecentTurns,
    compressAt: settings.context.compressAt,
    compression: settings.context.compression,
    identity,
    variables,
    sources: {
      profile: profileSource,
      model: modelSource,
      systemPrompt: promptSource,
      writingMode: modeSource,
      keepRecentTurns: keepSource,
      params: paramsSource,
      identity: identitySource,
    },
  };
}

export const LAYER_LABEL: Record<Layer, string> = {
  global: '继承全局',
  role: '来自角色',
  conversation: '本会话覆盖',
};
