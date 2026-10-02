import type { AvatarRef } from '@domain/value-objects/avatar';
import { makeAvatar } from '@domain/value-objects/avatar';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { WritingMode } from '@domain/value-objects/writingMode';
import type { RoleId } from '@shared/ids';
import type { RolePreset } from './rolePreset';

/**
 * 角色实例（Role Instance）
 *
 * ┌────────────────┐  实例化   ┌────────────────┐
 * │ RolePreset     │ ───────► │ RoleInstance   │
 * │ 「预制体」      │  创建会话  │ 「实例」        │
 * │ 编辑它 = 改模板 │          │ 快照，不再变    │
 * └────────────────┘          └────────────────┘
 *
 * 为什么需要这一层：
 *  - 如果会话直接引用角色预设，那么**改一次角色会串改所有历史会话**，
 *    昨天的对话今天换了个说法 —— 这在写作场景里是不可接受的；
 *  - 有了快照，历史对话永远可复现（配合 MessageNode 上的 paramsSnapshot）。
 *
 * 因此：**对话创建时实例化一次，之后只读。**
 * 会话内部仍可在实例之上做会话级覆盖（系统提示词 / 参数 / 称谓）。
 */
export interface RoleInstance {
  /** 来源角色 id，仅用于追溯与「重新同步」 */
  roleId: RoleId | null;
  name: string;
  avatar: AvatarRef;
  assistantName: string | null;
  userName: string | null;
  systemPrompt: string;
  greeting: string;
  modelProfileId: string | null;
  model: string | null;
  params: SamplingParams;
  writingMode: WritingMode | 'chat' | null;
  variables: Record<string, string>;
  /** 实例化时间，界面上可提示"该实例来自 x 分钟前的角色设定" */
  capturedAt: number;
}

export function instantiateRole(role: RolePreset, now: number): RoleInstance {
  return {
    roleId: role.id,
    name: role.name,
    avatar: makeAvatar(role.avatar),
    assistantName: role.assistantName,
    userName: role.userName,
    systemPrompt: role.systemPrompt,
    greeting: role.greeting,
    modelProfileId: role.modelProfileId,
    model: role.model,
    params: { ...role.params },
    writingMode: role.writingMode,
    variables: { ...role.variables },
    capturedAt: now,
  };
}


