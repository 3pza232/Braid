import type { RoleId } from '@shared/ids';
import type { AvatarRef } from '@domain/value-objects/avatar';
import { DEFAULT_ASSISTANT_AVATAR, makeAvatar } from '@domain/value-objects/avatar';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { WritingMode } from '@domain/value-objects/writingMode';

export const CURRENT_ROLE_SCHEMA_VERSION = 1;

/**
 * 角色名长度上限
 *
 * 与会话标题同理：它要在侧栏、角色面板列表、顶栏徽标这些**一行**的位置显示，
 * 超长会把那一行撑变形。60 字足够描述一个角色（"严谨的技术文档编辑"这种），
 * 再多就不是名字、而是说明了 —— 说明有 `description` 字段。
 */
export const MAX_ROLE_NAME_LENGTH = 60;

/**
 * 角色预设
 *
 * 定位：**用户自己搓的配置包**。Braid 只提供编辑器与解析规则，不预设倾向。
 *
 * 因此凡是「能继承就继承」：`null` 表示继承上一层（全局设置），
 * 只有用户在本角色里显式改过的字段才会被写进来。
 * 这样改了全局默认，所有没覆盖过的角色会自动跟随 —— 不会出现
 * "几十个角色各自冻结着一份旧参数"的僵硬状态。
 *
 * 提示词里可用的变量（由 MacroResolver 替换，见 M0-S3）：
 *   {{user}} {{char}} {{date}} {{time}} {{summary}} {{writing_mode}}
 */
export interface RolePreset {
  readonly id: RoleId;
  readonly schemaVersion: number;
  /** 内置角色只是"出厂样例"，用户可随意修改与删除，不是不可变数据 */
  builtin: boolean;

  name: string;
  avatar: AvatarRef;
  description: string;
  tags: string[];

  /** AI 在本角色下如何自称；null = 继承全局身份设置 */
  assistantName: string | null;
  /** AI 如何称呼用户；null = 继承全局身份设置 */
  userName: string | null;

  /** 系统提示词（预设词）。空字符串 = 不注入 system 消息 */
  systemPrompt: string;
  /** 开场白：新建会话时预填的第一条 assistant 消息 */
  greeting: string;

  /** 用哪一份模型配置；null = 继承全局当前配置 */
  modelProfileId: string | null;
  /** 模型名覆盖；null = 用配置里写的那一个 */
  model: string | null;
  /** 只存本角色显式覆盖过的采样参数 */
  params: SamplingParams;
  /** 输出档位；null = 继承全局默认档位 */
  writingMode: WritingMode | 'chat' | null;

  /** 自定义宏变量，会在提示词替换阶段优先于内置变量 */
  variables: Record<string, string>;

  /**
   * 手动排序位；`null` = 没被手动排过
   *
   * 顺序跟着行走（而不是存在设置里），这样导入导出、备份都会带上它，
   * 也不会出现"数据在表里、顺序在别处"的两份真相。
   */
  sortOrder: number | null;
  createdAt: number;
  updatedAt: number;
  /** 未知字段透传：保证更高版本导出的角色在低版本里往返不丢数据 */
  extensions?: Record<string, unknown>;
}

export function createEmptyRole(id: RoleId, now: number, init: Partial<RolePreset> = {}): RolePreset {
  return {
    id,
    schemaVersion: CURRENT_ROLE_SCHEMA_VERSION,
    builtin: false,
    sortOrder: null,
    name: '新角色',
    // 头像留空：界面会自动回落到「名称首字」+ 主题底色
    avatar: makeAvatar(),
    description: '',
    tags: [],
    assistantName: null,
    userName: null,
    systemPrompt: '',
    greeting: '',
    modelProfileId: null,
    model: null,
    params: {},
    writingMode: null,
    variables: {},
    createdAt: now,
    updatedAt: now,
    ...init,
  };
}

/**
 * 出厂样例角色
 *
 * 注意：它们只是**可编辑的起点**，不是产品倾向。
 * 用户可以直接删掉全部，从零开始搓；也可以用「新建空白角色」。
 */
export function builtinRoles(now: number): RolePreset[] {
  return [
    createEmptyRole('builtin.general' as RoleId, now, {
      builtin: true,
      name: '通用助手',
      avatar: DEFAULT_ASSISTANT_AVATAR,
      description: '出厂样例：简洁直接的回答风格',
      tags: ['样例'],
      assistantName: 'AI',
      systemPrompt:
        '你是一个严谨、直接的助手。先给结论，再给必要的解释。不要复述用户的问题，不要自我评价。',
    }),
    createEmptyRole('builtin.novelist' as RoleId, now, {
      builtin: true,
      name: '小说家',
      avatar: makeAvatar({ color: '#7C3AED' }),
      description: '出厂样例：中文长篇写作，重描写与节奏',
      tags: ['样例', '写作'],
      assistantName: '执笔',
      userName: '作者',
      systemPrompt:
        '你是一位擅长中文长篇的写作者。\n\n' +
        '规则：\n' +
        '1. 只写正文，不要解释你做了什么，不要写"好的，我来"这类开场。\n' +
        '2. 重视场景描写与节奏，对白与叙述交替。\n' +
        '3. 保持人物性格与既有设定一致。\n' +
        '4. 使用 {{user}} 指代作者，使用 {{char}} 指代你自己。',
      greeting: '',
      params: { temperature: 1.3 },
    }),
    createEmptyRole('builtin.coder' as RoleId, now, {
      builtin: true,
      name: '程序员',
      avatar: makeAvatar({ color: '#0EA5E9' }),
      description: '出厂样例：先结论后代码，标注文件路径',
      tags: ['样例', '开发'],
      assistantName: 'Dev',
      systemPrompt:
        '你是一位资深工程师。\n\n' +
        '规则：\n' +
        '1. 先给结论与风险，再给代码。\n' +
        '2. 代码块必须标注语言，并给出要修改的文件路径。\n' +
        '3. 不确定的地方明确说不确定，不要编造 API。',
      params: { temperature: 0.3 },
    }),
  ];
}

/** 导出为可读 JSON（供用户备份、分享、版本管理） */
export function serializeRole(role: RolePreset): string {
  return JSON.stringify({ ...role, builtin: false }, null, 2);
}

/**
 * 从外部 JSON 恢复角色
 *
 * 容错优先：缺字段补默认值、未知字段塞进 extensions 透传，
 * 这样"别人分享的角色"不会因为版本差异而导入失败。
 */
export function deserializeRole(raw: string, id: RoleId, now: number): RolePreset | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    /*
     * 已知字段清单
     *
     * 【这张表漏一个键，那个字段就会静默降级】—— 值会被塞进 `extensions`
     * （位置不对，读不到），类型字段则回落成默认值。曾经漏过 `modelProfileId`：
     * 导入带模型配置的角色后，配置悄悄没了，而 extensions 里多出一个没人看的键。
     * 所以新增可序列化字段时，**这里必须同步**，并有往返测试兜底。
     */
    const known = new Set([
      'name', 'avatar', 'description', 'tags', 'assistantName', 'userName',
      'systemPrompt', 'greeting', 'modelProfileId', 'model', 'params', 'writingMode',
      'variables',
      // `extensions` 自己也算"已知"：见下面的合并处理
      'extensions',
    ]);
    const extensions: Record<string, unknown> = {};

    /*
     * 先把**上一次导入时留下的透传字段**放进来
     *
     * 导出会把整个角色展开（`{...role}`），所以 `extensions` 会以 `extensions` 这个键
     * 出现在 JSON 里。若把它当成"未知字段"再收一次，就会变成
     * `extensions.extensions.extensions…` —— 每往返一次多套一层，直到没人看得懂。
     */
    const carried = parsed['extensions'];
    if (carried && typeof carried === 'object' && !Array.isArray(carried)) {
      Object.assign(extensions, carried as Record<string, unknown>);
    }
    for (const [key, value] of Object.entries(parsed)) {
      /*
       * `sortOrder` 也排除在外：顺序是**本地状态**，不该跟着角色文件传播 ——
       * 导入别人的角色不该让它插到你的列表中间去（默认落到末尾）。
       */
      const skip = key === 'id' || key === 'schemaVersion' || key === 'builtin' || key === 'sortOrder';
      if (!known.has(key) && !skip) extensions[key] = value;
    }

    const base = createEmptyRole(id, now);
    const rawAvatar = (parsed['avatar'] ?? {}) as Partial<AvatarRef>;

    return {
      ...base,
      name: typeof parsed['name'] === 'string' ? parsed['name'] : base.name,
      avatar: makeAvatar(rawAvatar),
      description: typeof parsed['description'] === 'string' ? parsed['description'] : '',
      tags: Array.isArray(parsed['tags']) ? (parsed['tags'] as string[]) : [],
      assistantName: typeof parsed['assistantName'] === 'string' ? parsed['assistantName'] : null,
      userName: typeof parsed['userName'] === 'string' ? parsed['userName'] : null,
      systemPrompt: typeof parsed['systemPrompt'] === 'string' ? parsed['systemPrompt'] : '',
      greeting: typeof parsed['greeting'] === 'string' ? parsed['greeting'] : '',
      modelProfileId:
        typeof parsed['modelProfileId'] === 'string' ? parsed['modelProfileId'] : null,
      model: typeof parsed['model'] === 'string' ? parsed['model'] : null,
      params: (parsed['params'] ?? {}) as SamplingParams,
      writingMode: (parsed['writingMode'] ?? null) as RolePreset['writingMode'],
      variables: (parsed['variables'] ?? {}) as Record<string, string>,
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  } catch {
    return null;
  }
}
