/**
 * 工作区路径规则（纯领域规则）
 *
 * 【为什么这里只处理"相对路径"，而不做"路径是否在根目录内"的判断】
 *
 * 这是本模块最关键的取舍，值得写清楚：
 *
 * 传统做法是拼出绝对路径再判断 `startsWith(root)`，但那个做法有两个致命缺陷：
 *  - **字符串前缀比较不可靠**：`C:\proj-evil` 会以 `C:\proj` 为前缀，
 *    必须额外处理分隔符与大小写（Windows 还大小写不敏感）——这正是历史上
 *    大量目录穿越漏洞的来源；
 *  - **浏览器里根本没有绝对路径**。File System Access API 只给你一个目录句柄，
 *    拿不到 `C:\...` 这样的字符串。
 *
 * 所以本项目采取**更简单也更可靠**的方案：所有文件操作都接收
 * **相对于工作区根目录的路径**，由句柄 API 自己做解析（`getFileHandle(name)`），
 * 而这里只负责一件事 —— **保证相对路径不会向上逃逸**。
 *
 * 只要路径里不含 `..`、不是绝对路径、不是盘符路径，那么无论底层怎么解析，
 * 结果都必然落在工作区内。这个不变量是**结构性成立**的，不依赖字符串比较。
 */

/** 拒绝原因。用枚举而不是自由文本，方便上层（含测试）精确断言 */
export type PathRejection =
  | 'empty'
  | 'absolute'
  | 'drive'
  | 'escape'
  | 'nul'
  | 'too_deep';

export type PathVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathRejection; readonly message: string };

/** 路径深度上限：挡掉"几千层 ../../"这类明显的构造型输入 */
const MAX_DEPTH = 48;

const REASON_MESSAGE: Record<PathRejection, string> = {
  empty: '路径为空',
  absolute: '不允许绝对路径：只能访问工作区目录内的文件',
  drive: '不允许盘符路径：只能访问工作区目录内的文件',
  escape: '路径越出工作区目录，已拒绝',
  nul: '路径包含非法字符',
  too_deep: `路径层级过深（上限 ${MAX_DEPTH} 层）`,
};

const reject = (reason: PathRejection): PathVerdict => ({
  ok: false,
  reason,
  message: REASON_MESSAGE[reason],
});

/**
 * 归一化并校验一个工作区相对路径
 *
 * 归一化做的是"把等价写法收敛成同一个字符串"：`a//b`、`a/./b`、`a\b` 都是 `a/b`。
 * 收敛之后再校验，就不存在"用 `../` 的变形绕过检查"的空间。
 */
export function normalizeWorkspacePath(input: string): PathVerdict {
  if (typeof input !== 'string') return reject('empty');

  // 统一分隔符：Windows 风格的反斜杠与正斜杠等价，先收敛再判断
  const unified = input.replace(/\\/g, '/');

  if (unified.includes('\0')) return reject('nul');
  // 绝对路径（`/x`、`//server/share`）与盘符路径（`C:/x`）都不允许：
  // 工作区是唯一的根，任何"从根之外开始"的写法都必须拒绝而不是尝试修正
  if (unified.startsWith('/')) return reject('absolute');
  if (/^[a-zA-Z]:/.test(unified)) return reject('drive');

  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return reject('empty');
  if (segments.includes('..')) return reject('escape');
  if (segments.length > MAX_DEPTH) return reject('too_deep');

  return { ok: true, path: segments.join('/') };
}

/**
 * 列出目录时用的父目录归一化
 *
 * 与文件路径的区别：**允许空**，因为"工作区根目录"本身就是一个合法目标。
 */
export function normalizeWorkspaceDir(input: string | null | undefined): PathVerdict {
  if (input === null || input === undefined || input === '') return { ok: true, path: '' };
  return normalizeWorkspacePath(input);
}

/** 拼一个子路径（用于列目录时展示每一项的相对路径） */
export function joinWorkspacePath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}
