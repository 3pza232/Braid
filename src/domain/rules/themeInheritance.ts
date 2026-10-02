/**
 * 外置主题文件的解析规则（纯函数）
 *
 * 【为什么外置主题只写"差异"】
 * 一个完整主题有 90 多个 token（色阶 + 语义 + 字体 + 间距 + 阴影 + 动效……），
 * 让主题作者从零抄一遍既容易错、也没必要 —— 绝大多数自定义主题
 * 只是想"换个底色和强调色"。所以外置文件**必须**声明 `extends`，
 * 指向一个已注册的基础主题，文件里只写要覆盖的 token，其余全部继承。
 *
 * 【为什么校验放在 domain】
 * "什么是一个合法的主题覆盖文件"是一条纯规则，不碰文件系统。
 * 放在这里就能用测试钉住，也能被将来的"从文件导入主题"功能复用。
 *
 * 【为什么不用 ports 里的 Theme 类型】
 * domain 不允许依赖 ports（分层规则）。这里的输入/输出都是**结构化**的
 * 最小形状 —— 合并规则对 token 的具体形状没有要求，
 * 适配器拿到结果后做一次类型收口即可（tokens 本来就来自基础主题，是安全的）。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 基础主题的最小形状（结构化，不依赖 ports 契约） */
export interface ThemeBase {
  id: string;
  name: string;
  tokens: unknown;
}

export interface ResolvedThemeFile {
  id: string;
  name: string;
  version: string;
  colorScheme: 'light' | 'dark';
  tokens: unknown;
  meta: { description?: string; extends: string };
}

/**
 * 深合并：对象递归合并，标量与数组直接覆盖
 *
 * 只对**纯对象**递归 —— 数组与其它类型一律整体替换，
 * 避免出现"数组和对象合并出怪物"的情况。
 */
export function mergeTokens<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : (override as T);
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 显式写 undefined 视为"没写"：保留基础值（上面那个分支只处理整个 override 是 undefined 的情况）
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? mergeTokens(base[key], value) : value;
  }
  return out as T;
}

/** 解析失败的原因。给主题作者看得懂的错误，而不是一句"格式错误" */
export type ThemeFileError =
  | 'not-an-object'
  | 'missing-id'
  | 'missing-name'
  | 'bad-color-scheme'
  | 'unknown-base'
  | 'missing-tokens';

/** 解析外置主题。失败返回原因（loader 转成日志），成功返回补全后的完整主题 */
export function resolveThemeFile(
  raw: unknown,
  base: ThemeBase,
): { ok: true; theme: ResolvedThemeFile } | { ok: false; reason: ThemeFileError } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-an-object' };

  const { id, name, version, colorScheme, extends: extendsId, description, tokens } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return { ok: false, reason: 'missing-id' };
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, reason: 'missing-name' };
  }
  if (colorScheme !== 'light' && colorScheme !== 'dark') {
    return { ok: false, reason: 'bad-color-scheme' };
  }
  // 必须显式继承，且指向的就是这一个基础主题（loader 按 base 查找，两者必须一致）
  if (extendsId !== base.id) return { ok: false, reason: 'unknown-base' };
  if (!isPlainObject(tokens)) return { ok: false, reason: 'missing-tokens' };

  return {
    ok: true,
    theme: {
      id,
      name,
      version: typeof version === 'string' ? version : '1.0.0',
      colorScheme,
      tokens: mergeTokens(base.tokens, tokens),
      meta: {
        ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
        extends: base.id,
      },
    },
  };
}
