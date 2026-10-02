/**
 * 工作区（值对象）
 *
 * 工作区 = 这场对话可以触及的本地目录。两条权限规则的**默认值刻意不对称**：
 *
 *  - **读：默认允许**。读不会改变任何东西，且用户已经明确选了这个目录 ——
 *    再为"读"加一道确认，只会让人一路点同意，反而把"写"的确认也变成形式主义。
 *  - **写：默认禁止**。写会改变磁盘上的东西，且不可撤销（没有版本库兜底）。
 *    模型猜错一次就可能覆盖掉用户的作品，所以必须由用户**显式**打开开关。
 *
 * 开关做成两级（全局默认 + 会话覆盖）而不是只有一个全局开关，理由很实际：
 * "让我随便改这个草稿项目"与"别碰我的正式仓库"是同一个人在不同对话里的需求。
 */
export interface WorkspaceSettings {
  /** 是否允许 AI 编辑工作区文件（全局默认；会话可覆盖） */
  allowEdit: boolean;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  // 默认关闭：宁可让用户"发现要多点一下开关"，也不能让 AI 悄悄改他的文件
  allowEdit: false,
};

/** 权限最终来自哪一层 —— 界面上要写清楚，否则用户会疑惑"我全局开了为什么没生效" */
export type WorkspacePermissionSource = 'conversation' | 'global';

export interface ResolvedWorkspacePermission {
  allowEdit: boolean;
  source: WorkspacePermissionSource;
}

export interface WorkspacePermissionInput {
  global: WorkspaceSettings;
  /** 会话级覆盖：`null` 表示继承全局 */
  override: boolean | null;
}

/**
 * 解析"本会话能否编辑工作区文件"
 *
 * 判定顺序与其它配置一致：**会话覆盖 > 全局默认**。
 * `override` 用 `null` 而不是 `false` 表示"未设置"：
 * 否则用户无法区分"我明确关掉了"与"我没表态"，后者在全局开关打开时会失效。
 */
export function resolveWorkspacePermission(
  input: WorkspacePermissionInput,
): ResolvedWorkspacePermission {
  if (input.override !== null) {
    return { allowEdit: input.override, source: 'conversation' };
  }
  return { allowEdit: input.global.allowEdit, source: 'global' };
}
