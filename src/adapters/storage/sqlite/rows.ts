import type { RolePreset } from '@domain/entities/rolePreset';
import { CURRENT_ROLE_SCHEMA_VERSION, createEmptyRole } from '@domain/entities/rolePreset';
import type { AvatarRef } from '@domain/value-objects/avatar';
import { makeAvatar } from '@domain/value-objects/avatar';
import type { SamplingParams } from '@domain/value-objects/sampling';
import type { WritingMode } from '@domain/value-objects/writingMode';
import type { SqlValue } from '@ports/host/SqlPort';
import { asRoleId } from '@shared/ids';
// 实现在零依赖的 upsert.ts（门禁脚本也要用它），这里只是转出去给各仓储引用
import { buildUpsert } from './upsert';

export { buildUpsert };

/**
 * 行 ↔ 实体的映射
 *
 * 为什么集中在一个文件：
 *  - 列名、序列化方式、容错规则只写一遍，SQL 语句与映射不可能对不上；
 *  - 以后新增字段（A1「角色加字段，核心层零改动」）只改这里与 migration。
 *
 * 容错原则：**读的时候永远不假设数据完好**。
 * 数据库里可能躺着旧版本写的行、被手工改坏的行，映射层必须把它们
 * 收敛成合法实体，而不是让 `undefined` 一路冒到 UI 引起白屏。
 */

export type SqlRow = Record<string, SqlValue>;

/* ────────────────────────────── 基础取值 ────────────────────────────── */

export function toJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

export function parseJson<T>(raw: SqlValue | undefined, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** 是不是"纯对象"：数组、标量、null 都不算（它们的出现都说明那一格是坏数据） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 取一个 JSON **对象**字段
 *
 * 【为什么不能只用 `parseJson`】
 * `parseJson` 只保证"解析得出来"，不保证**形状**。库里那一格可能是手工改的、
 * 旧版本写坏的，于是完全可能是 `42`、`"x"`、`[]` —— 那样 `params` 会变成数字、
 * `roleInstance` 会变成数组：类型上说得过去，运行到时才在别处炸
 *（`undefined.color` 这种），而报错点离坏数据很远。
 *
 * 这里把"形状不对"也当坏数据，统一退回 fallback —— 读取时永远不假设数据完好。
 */
export function parseJsonObject<T>(raw: SqlValue | undefined, fallback: T): T {
  const parsed = parseJson<unknown>(raw, fallback);
  return isPlainObject(parsed) ? (parsed as T) : fallback;
}

/**
 * 取一个 JSON **数组**字段（可逐项校验，丢掉不合规的项）
 *
 * `tags_json` 曾经直接 `.filter()`：库里那格是 `42` 时，整个装载会在
 * `parseJson(...).filter is not a function` 上抛掉 —— **一条坏数据让应用打不开**。
 */
export function parseJsonArray<T>(
  raw: SqlValue | undefined,
  isItem: (item: unknown) => item is T,
): T[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.filter(isItem) : [];
}

/** 取整数；非数字一律回落，避免 NaN 污染业务 */
export function toInt(raw: SqlValue | undefined, fallback = 0): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 取字符串；空串按"没有值"处理（与实体里的 null = 继承 语义对齐） */
export function toText(raw: SqlValue | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return raw.length > 0 ? raw : null;
}

/** 取布尔（SQLite 没有布尔类型，用 0/1 存） */
export function toBool(raw: SqlValue | undefined): boolean {
  return toInt(raw, 0) === 1;
}

/**
 * 取可空数字
 *
 * 与 `toInt` 的区别：**保留 null**。
 * 例如 `min_output_chars` 的 null 语义是"继承全局档位"，绝不能退化成 0。
 */
export function toNumOrNull(raw: SqlValue | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}



/* ────────────────────────────── 角色预设 ────────────────────────────── */

/**
 * 列清单
 *
 * 下面的 UPSERT 语句与 `roleParams` 都从这一个数组派生，
 * 因此**不可能出现"加了列但漏改某一处"**的错误。
 */
export const ROLE_COLUMNS = [
  'id',
  'name',
  'avatar_json',
  'description',
  'tags_json',
  'assistant_name',
  'user_name',
  'system_prompt',
  'greeting',
  'model_profile_id',
  'model',
  'params_json',
  'writing_mode',
  'variables_json',
  'builtin',
  'sort_order',
  'created_at',
  'updated_at',
  'extensions_json',
  'schema_version',
] as const;

type RoleColumn = (typeof ROLE_COLUMNS)[number];

export const ROLE_UPSERT_SQL = buildUpsert('role_preset', ROLE_COLUMNS);

function roleToRowObject(role: RolePreset): Record<RoleColumn, SqlValue> {
  return {
    id: role.id,
    name: role.name,
    avatar_json: toJson(role.avatar),
    description: role.description,
    tags_json: toJson(role.tags),
    // 空串统一存 NULL：与"null = 继承"的语义保持一致，避免两种"空"并存
    assistant_name: toText(role.assistantName),
    user_name: toText(role.userName),
    system_prompt: role.systemPrompt,
    greeting: role.greeting,
    model_profile_id: toText(role.modelProfileId),
    model: toText(role.model),
    params_json: toJson(role.params),
    writing_mode: role.writingMode,
    variables_json: toJson(role.variables),
    builtin: role.builtin ? 1 : 0,
    sort_order: role.sortOrder,
    created_at: role.createdAt,
    updated_at: role.updatedAt,
    extensions_json: toJson(role.extensions ?? {}),
    schema_version: role.schemaVersion,
  };
}

/** 按 ROLE_COLUMNS 的顺序生成绑定参数 */
export function roleParams(role: RolePreset): SqlValue[] {
  const row = roleToRowObject(role);
  return ROLE_COLUMNS.map((column) => row[column]);
}

export function roleFromRow(row: SqlRow): RolePreset {
  const createdAt = toInt(row['created_at'], Date.now());
  const base = createEmptyRole(asRoleId(String(row['id'] ?? '')), createdAt);
  const extensions = parseJsonObject<Record<string, unknown>>(row['extensions_json'], {});

  return {
    ...base,
    schemaVersion: toInt(row['schema_version'], CURRENT_ROLE_SCHEMA_VERSION),
    builtin: toBool(row['builtin']),
    sortOrder: toNumOrNull(row['sort_order']),
    name: typeof row['name'] === 'string' ? row['name'] : base.name,
    avatar: makeAvatar(parseJsonObject<Partial<AvatarRef>>(row['avatar_json'], {})),
    description: typeof row['description'] === 'string' ? row['description'] : '',
    tags: parseJsonArray<string>(row['tags_json'], (tag): tag is string => typeof tag === 'string'),
    assistantName: toText(row['assistant_name']),
    userName: toText(row['user_name']),
    systemPrompt: typeof row['system_prompt'] === 'string' ? row['system_prompt'] : '',
    greeting: typeof row['greeting'] === 'string' ? row['greeting'] : '',
    modelProfileId: toText(row['model_profile_id']),
    model: toText(row['model']),
    params: parseJsonObject<SamplingParams>(row['params_json'], {}),
    writingMode: typeof row['writing_mode'] === 'string' ? (row['writing_mode'] as WritingMode | 'chat') : null,
    variables: parseJsonObject<Record<string, string>>(row['variables_json'], {}),
    createdAt,
    updatedAt: toInt(row['updated_at'], createdAt),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}
