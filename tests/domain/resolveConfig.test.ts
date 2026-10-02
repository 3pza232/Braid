import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  createModelProfile,
  type AppSettings,
} from '@domain/value-objects/appSettings';
import { DEFAULT_ASSISTANT_AVATAR, makeAvatar } from '@domain/value-objects/avatar';
import { createEmptyConversation, type Conversation } from '@domain/entities/conversation';
import type { RoleInstance } from '@domain/entities/roleInstance';
import { resolveConfig } from '@domain/rules/resolveConfig';
import { asConversationId } from '@shared/ids';

/**
 * 三层配置解析（全局 → 角色实例 → 会话覆盖）
 *
 * 这是全应用**唯一**做优先级合并的地方：UI 的「继承中 / 已覆盖」标注、
 * 请求组装、上下文构建全都吃它的结果。所以这里出错的表现是"改了设置没生效"
 * 或"某个会话莫名用了别的模型"—— 都是用户最先发现、最难倒查的那类问题。
 *
 * 全部用例围绕同一条规则：**后一层只覆盖它显式写过的字段，null / 空白 = 继承**。
 */

// 在模块级创建，保证 id 在整个文件里稳定（createModelProfile 会生成新 id）
const profileA = createModelProfile({
  name: '默认配置',
  baseUrl: 'https://a.example/v1',
  model: 'model-a',
});
const profileB = createModelProfile({
  name: '备用配置',
  baseUrl: 'https://b.example/v1',
  model: 'model-b',
});

/** 以 A 为「全局当前」，B 留给"被上层显式选中"的用例 */
function settingsWith(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    model: { profiles: [profileA, profileB], activeProfileId: profileA.id },
    ...overrides,
  };
}

function instanceWith(overrides: Partial<RoleInstance> = {}): RoleInstance {
  return {
    roleId: null,
    name: '测试角色',
    avatar: makeAvatar(),
    assistantName: null,
    userName: null,
    systemPrompt: '角色的系统提示词',
    greeting: '',
    modelProfileId: null,
    model: null,
    params: {},
    writingMode: null,
    variables: {},
    capturedAt: 0,
    ...overrides,
  };
}

const conv = (init: Partial<Conversation> = {}): Conversation =>
  createEmptyConversation(asConversationId('c1'), 100, init);

describe('模型配置（端点 + 凭据）：会话 → 角色 → 全局当前', () => {
  it('都没有指定时用全局当前那一份', () => {
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.profile).toBe(profileA);
    expect(resolved.baseUrl).toBe('https://a.example/v1');
    expect(resolved.sources.profile).toBe('global');
  });

  it('角色实例指定了就优先于全局', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({ roleInstance: instanceWith({ modelProfileId: profileB.id }) }),
    );
    expect(resolved.profile).toBe(profileB);
    expect(resolved.sources.profile).toBe('role');
  });

  it('会话指定的优先级最高', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({
        modelProfileId: profileB.id,
        roleInstance: instanceWith({ modelProfileId: profileA.id }),
      }),
    );
    expect(resolved.profile).toBe(profileB);
    expect(resolved.sources.profile).toBe('conversation');
  });

  it('指向一个已被删掉的配置时继续往下找，不会得到空配置', () => {
    // 用户删掉"当前配置"后，历史会话里的 id 就失效了 —— 此时必须还能正常工作
    const resolved = resolveConfig(settingsWith(), conv({ modelProfileId: 'ghost' }));
    expect(resolved.profile).toBe(profileA);
  });

  it('一份配置都没有时给安全默认值，界面据此提示"去添加配置"', () => {
    const resolved = resolveConfig(
      settingsWith({ model: { profiles: [], activeProfileId: '' } }),
      conv(),
    );
    expect(resolved.profile).toBeNull();
    expect(resolved.baseUrl).toBe('');
    expect(resolved.apiKey).toBe('');
    expect(resolved.requestTimeoutMs).toBe(120_000);
    expect(resolved.model).toBe('');
  });
});

describe('采样参数：逐层合并，后层只覆盖写过的字段', () => {
  it('会话没写参数时继承全局', () => {
    const resolved = resolveConfig(
      settingsWith({ sampling: { temperature: 0.8, topP: 0.9 } }),
      conv(),
    );
    expect(resolved.params).toEqual({ temperature: 0.8, topP: 0.9 });
    expect(resolved.sources.params).toBe('global');
  });

  it('角色只写了 topP，temperature 仍然跟着全局走（不是整份替换）', () => {
    const resolved = resolveConfig(
      settingsWith({ sampling: { temperature: 0.8, topP: 0.9 } }),
      conv({ roleInstance: instanceWith({ params: { topP: 0.5 } }) }),
    );
    expect(resolved.params).toEqual({ temperature: 0.8, topP: 0.5 });
    expect(resolved.sources.params).toBe('role');
  });

  it('三层同时存在时逐字段取最高层', () => {
    const resolved = resolveConfig(
      settingsWith({ sampling: { temperature: 0.8, topP: 0.9, maxTokens: 1000 } }),
      conv({
        params: { temperature: 0.1 },
        roleInstance: instanceWith({ params: { topP: 0.5 } }),
      }),
    );
    expect(resolved.params).toEqual({ temperature: 0.1, topP: 0.5, maxTokens: 1000 });
    expect(resolved.sources.params).toBe('conversation');
  });
});

describe('系统提示词与模型名：空白等于没写', () => {
  it('完全没有角色时提示词是空的，而不是拼一段默认话术', () => {
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.systemPrompt).toBe('');
  });

  it('会话写空白串视为没写，继续用角色的', () => {
    // 用户把输入框清空后点保存，语义应该是"恢复继承"，不是"覆盖成空"
    const resolved = resolveConfig(
      settingsWith(),
      conv({
        systemPrompt: '   ',
        model: '',
        roleInstance: instanceWith({ systemPrompt: '角色词', model: 'role-model' }),
      }),
    );
    expect(resolved.systemPrompt).toBe('角色词');
    expect(resolved.sources.systemPrompt).toBe('role');
    expect(resolved.model).toBe('role-model');
    expect(resolved.sources.model).toBe('role');
  });

  it('会话写了就用会话的', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({
        systemPrompt: '会话词',
        model: 'conv-model',
        roleInstance: instanceWith({ systemPrompt: '角色词', model: 'role-model' }),
      }),
    );
    expect(resolved.systemPrompt).toBe('会话词');
    expect(resolved.model).toBe('conv-model');
    expect(resolved.sources.systemPrompt).toBe('conversation');
    expect(resolved.sources.model).toBe('conversation');
  });

  it('都没写时用配置里的模型名', () => {
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.model).toBe('model-a');
    expect(resolved.sources.model).toBe('global');
  });
});

describe('输出档位：会话 → 角色 → 全局默认', () => {
  it("'chat'（普通对话）视为没设置，继续往上层找", () => {
    // 否则用户开了续写档位后切回普通对话，历史会话会把它"钉"在 chat 上
    const resolved = resolveConfig(
      settingsWith({ defaultWritingMode: 'medium' }),
      conv({ writingMode: 'chat', roleInstance: instanceWith({ writingMode: 'long' }) }),
    );
    expect(resolved.writingMode).toBe('long');
    expect(resolved.sources.writingMode).toBe('role');
  });

  it('角色也是 chat 时落到全局默认档位', () => {
    const resolved = resolveConfig(
      settingsWith({ defaultWritingMode: 'medium' }),
      conv({ roleInstance: instanceWith({ writingMode: 'chat' }) }),
    );
    expect(resolved.writingMode).toBe('medium');
    expect(resolved.sources.writingMode).toBe('global');
  });

  it('全局默认也是 chat 时最终就是普通对话', () => {
    const resolved = resolveConfig(settingsWith({ defaultWritingMode: 'chat' }), conv());
    expect(resolved.writingMode).toBe('chat');
  });

  it('会话档位优先于角色档位', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({ writingMode: 'short', roleInstance: instanceWith({ writingMode: 'long' }) }),
    );
    expect(resolved.writingMode).toBe('short');
    expect(resolved.sources.writingMode).toBe('conversation');
  });
});

describe('续写引擎的唯一输入源（档位细节在这里解析完，引擎只吃快照）', () => {
  it('字数下限用会话覆盖，没有就用该档位的全局预设', () => {
    const longPreset = DEFAULT_APP_SETTINGS.writingModes.long;
    expect(resolveConfig(settingsWith(), conv({ writingMode: 'long' })).minOutputChars).toBe(
      longPreset.minOutputChars,
    );
    expect(
      resolveConfig(settingsWith(), conv({ writingMode: 'long', minOutputChars: 123 })).minOutputChars,
    ).toBe(123);
  });

  it('普通对话借"短"档位的预算，但不会自动续写', () => {
    // chat 没有自己的档位预设，借用 short 的数值；而 short 的 continuation 是 off，
    // 于是"普通对话不会莫名其妙续写"这件事由数据保证，而不是靠引擎里的 if
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.writingMode).toBe('chat');
    expect(resolved.continuation).toBe('off');
    expect(resolved.minOutputChars).toBe(DEFAULT_APP_SETTINGS.writingModes.short.minOutputChars);
  });

  it('软上限严格大于下限 —— 否则会在达标之前就停下', () => {
    for (const mode of ['short', 'medium', 'long'] as const) {
      const resolved = resolveConfig(settingsWith(), conv({ writingMode: mode }));
      expect(resolved.softMaxChars).toBeGreaterThan(resolved.minOutputChars);
    }
  });

  it('stallLimit 来自该档位；「单轮输出上限」与档位无关，是全局共享的采样参数', () => {
    const resolved = resolveConfig(settingsWith(), conv({ writingMode: 'long' }));
    const preset = DEFAULT_APP_SETTINGS.writingModes.long;
    expect(resolved.stallLimit).toBe(preset.stallLimit);
    /*
     * 它既会变成请求里的 max_tokens，又决定上下文的输出预留 ——
     * 所以只能有一份（早先档位里另有一个 maxTokensPerRequest，已合并到采样参数）。
     */
    expect(resolved.outputReserve).toBe(DEFAULT_APP_SETTINGS.sampling.maxTokens);
  });

  it('续写提示词会话可覆盖，否则用全局那一份', () => {
    expect(resolveConfig(settingsWith(), conv()).continuationPrompt).toBe(
      DEFAULT_APP_SETTINGS.continuationPrompt,
    );
    expect(
      resolveConfig(settingsWith(), conv({ continuationPrompt: '  自己写的  ' })).continuationPrompt,
    ).toBe('  自己写的  ');
  });
});

describe('上下文预算与压缩', () => {
  it('预算 = 上下文长度 − 单轮输出上限；长度只有全局一层（会话改它没有正当用途）', () => {
    const resolved = resolveConfig(
      settingsWith({
        context: { ...DEFAULT_APP_SETTINGS.context, maxContextTokens: 10_000 },
        sampling: { ...DEFAULT_APP_SETTINGS.sampling, maxTokens: 2_000 },
      }),
      conv(),
    );

    expect(resolved.maxContextTokens).toBe(10_000);
    // 输出预留就是"要下发的 max_tokens"，不再单独配置
    expect(resolved.outputReserve).toBe(2_000);
    expect(resolved.contextBudget).toBe(8_000);
  });

  it('保留轮数会话可覆盖 —— 写小说与问代码想留住的历史长度不同', () => {
    const resolved = resolveConfig(
      settingsWith({ context: { ...DEFAULT_APP_SETTINGS.context, keepRecentMessages: 6 } }),
      conv({ keepRecentMessages: 2 }),
    );
    expect(resolved.keepRecentTurns).toBe(2);
    expect(resolved.sources.keepRecentTurns).toBe('conversation');
  });

  it('保留轮数没写就跟全局', () => {
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.keepRecentTurns).toBe(DEFAULT_APP_SETTINGS.context.keepRecentMessages);
    expect(resolved.sources.keepRecentTurns).toBe('global');
  });

  it('压缩开关与触发线由全局设置决定', () => {
    const resolved = resolveConfig(
      settingsWith({
        context: { ...DEFAULT_APP_SETTINGS.context, compression: 'off', compressAt: 0.6 },
      }),
      conv(),
    );
    expect(resolved.compression).toBe('off');
    expect(resolved.compressAt).toBe(0.6);
  });

  it('默认是自动压缩 —— 不配也能在长对话里活下去', () => {
    expect(resolveConfig(settingsWith(), conv()).compression).toBe('auto');
    expect(resolveConfig(settingsWith(), conv()).compressAt).toBe(0.85);
  });
});

describe('身份与宏变量', () => {
  it('会话 > 角色 > 全局，逐字段独立判断', () => {
    const resolved = resolveConfig(
      settingsWith({
        identity: {
          ...DEFAULT_APP_SETTINGS.identity,
          userName: '全局用户',
          assistantName: '全局助手',
        },
      }),
      conv({
        userName: '会话用户',
        roleInstance: instanceWith({ userName: '角色用户', assistantName: '角色助手' }),
      }),
    );
    expect(resolved.identity.userName).toBe('会话用户');
    expect(resolved.identity.assistantName).toBe('角色助手');
    expect(resolved.sources.identity).toBe('conversation');
  });

  it('角色没设名字时用全局的', () => {
    const resolved = resolveConfig(
      settingsWith({
        identity: {
          ...DEFAULT_APP_SETTINGS.identity,
          userName: '全局用户',
          assistantName: '全局助手',
        },
      }),
      conv({ roleInstance: instanceWith() }),
    );
    expect(resolved.identity).toMatchObject({ userName: '全局用户', assistantName: '全局助手' });
    expect(resolved.sources.identity).toBe('global');
  });

  it('助手头像来自角色实例（角色是"长相"的唯一来源）', () => {
    const avatar = makeAvatar({ image: 'data:image/png;base64,xxx' });
    const resolved = resolveConfig(
      settingsWith(),
      conv({ roleInstance: instanceWith({ avatar }) }),
    );
    expect(resolved.identity.assistantAvatar).toBe(avatar);
  });

  it('无角色时助手头像退回全局身份设置（全局也没有才用内置默认）', () => {
    const resolved = resolveConfig(settingsWith(), conv());
    expect(resolved.identity.assistantAvatar).toBe(
      DEFAULT_APP_SETTINGS.identity.assistantAvatar ?? DEFAULT_ASSISTANT_AVATAR,
    );
  });

  it('内置宏变量：{{user}} / {{char}} / {{writing_mode}}', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({
        assistantName: '小助',
        userName: '老王',
        writingMode: 'long',
      }),
    );
    expect(resolved.variables).toMatchObject({
      user: '老王',
      char: '小助',
      writing_mode: 'long',
    });
  });

  it('普通对话时 writing_mode 给中文名，而不是裸露的 chat', () => {
    expect(resolveConfig(settingsWith(), conv()).variables.writing_mode).toBe('普通对话');
  });

  it('角色自定义变量优先于内置变量（同名时以角色为准）', () => {
    const resolved = resolveConfig(
      settingsWith(),
      conv({
        userName: '老王',
        roleInstance: instanceWith({ variables: { user: '老爷', tone: '温柔' } }),
      }),
    );
    expect(resolved.variables.user).toBe('老爷');
    expect(resolved.variables.tone).toBe('温柔');
  });
});
