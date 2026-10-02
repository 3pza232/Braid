/**
 * 提示词宏替换
 *
 * 支持 `{{变量名}}`，变量优先级见 `resolveConfig`：角色自定义变量 > 内置变量。
 *
 * 【与缓存命中率的直接关系】
 * 宏替换的结果必须**逐字节稳定**：同样的会话、同样的设置，两次请求必须产出完全相同的
 * 系统提示词。所以：
 *  - **不要**往内置变量里塞时间戳 / 随机数 / 计数器（`{{date}}` 只到天）；
 *  - 替换是纯函数、不做排序或格式化上的抖动。
 * 前缀缓存要求从第一个字符起完全一致，开头一变，后面几万 token 的缓存全部失效。
 *
 * 未知变量**原样保留**（连同花括号）：写错 `{{chra}}` 时用户能在提示词预览里一眼看到，
 * 如果替换成空串，这个错误会变成"模型表现莫名变差"，几乎无从排查。
 */
export function resolveMacros(text: string, variables: Record<string, string>): string {
  if (!text || text.indexOf('{{') < 0) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

/** 找出文本里所有未知变量名（用于角色编辑器的实时校验提示） */
export function findUnknownMacros(
  text: string,
  variables: Record<string, string>,
): string[] {
  const unknown = new Set<string>();
  const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (name && variables[name] === undefined) unknown.add(name);
  }
  return [...unknown];
}
