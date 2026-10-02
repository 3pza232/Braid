/**
 * 外置主题加载器
 *
 * 【主题从哪来】两个来源，语义是**"有运行时目录就只听它的"**：
 *  1. **打包进应用**的 `themes/*.json`（浏览器里跑的时候用它）；
 *  2. **运行时目录**（桌面版：exe 同级的 `themes/`）—— 放一个文件进去、重启就能选到，
 *     删掉文件就真的没了。这才叫"可拔插"。
 *
 * 为什么不把两者合并：合并的话"删掉文件"不会让主题消失（打包的那份还在），
 * 用户会觉得"我删了它怎么还在" —— 那种困惑没有答案能解释得通。
 *
 * 【文件格式】必须写 `"extends": "braid.light" | "braid.dark"`，
 * 文件里只放要覆盖的 token，其余从基础主题继承（见 domain/rules/themeInheritance.ts）。
 * 一个最小可用的主题文件长这样：
 *
 * ```json
 * {
 *   "id": "my-theme", "name": "我的主题", "version": "1.0.0",
 *   "colorScheme": "dark", "extends": "braid.dark",
 *   "tokens": { "semantic": { "accent": { "default": "#FF6600" } } }
 * }
 * ```
 *
 * 【坏文件怎么办】解析失败的主题**跳过并打日志**，绝不让它拖垮启动 ——
 * 一个手滑写错 JSON 的主题文件不应该导致整个应用白屏。
 */
import { resolveThemeFile } from '@domain/rules/themeInheritance';
import type { Theme } from '@ports/Theme';

/** 运行时主题目录的地址（由桌面壳的本地服务提供；普通浏览器里不存在，会 404） */
export const RUNTIME_THEME_ENDPOINT = '/_external-themes';

/** 原始主题文件（还没校验） */
interface RawThemeFile {
  /** 用在日志里的来源标记：`themes/ocean.json` 或 `运行时主题 ocean.json` */
  label: string;
  raw: unknown;
}

/**
 * 一批原始文件的**共同**校验路径
 *
 * 打包来源与运行时来源必须走同一段代码：分成两份的话，"什么叫合法主题"
 * 就会有两套解释，改一处漏一处 —— 而症状是"同一个文件在开发时能用、装完就不能用"。
 */
function themesFromFiles(files: readonly RawThemeFile[], builtin: readonly Theme[]): Theme[] {
  const loaded: Theme[] = [];

  for (const { label, raw } of files) {
    const extendsId = (raw as { extends?: unknown } | null)?.extends;
    const base = builtin.find((theme) => theme.id === extendsId);

    if (!base) {
      console.warn(
        `[themes] ${label} 已忽略：extends 必须指向已注册的基础主题（${builtin
          .map((theme) => theme.id)
          .join(' / ')}）`,
      );
      continue;
    }

    const result = resolveThemeFile(raw, base);
    if (result.ok) {
      /*
       * 类型收口：合并结果里的 tokens 来自基础主题（深合并），形状必然完整。
       * 这是唯一一次 unknown → Theme 的转换，且有 domain 规则的结构校验兜底。
       */
      loaded.push(result.theme as Theme);
    } else {
      console.warn(`[themes] ${label} 已忽略：${result.reason}`);
    }
  }

  return loaded;
}

/** 打包进应用的那批（浏览器里唯一的来源） */
const bundled = import.meta.glob('/themes/*.json', { eager: true });

export function loadExternalThemes(builtin: readonly Theme[]): Theme[] {
  const files: RawThemeFile[] = Object.entries(bundled).map(([file, module]) => ({
    label: file,
    // Vite 的 JSON 导入把内容放在 default 上；构建配置变了就退回整体
    raw: (module as { default?: unknown }).default ?? module,
  }));
  return themesFromFiles(files, builtin);
}

/**
 * 运行时目录（桌面版 exe 同级的 `themes/`）
 *
 * 【为什么用 fetch 而不是 fs】渲染进程没有、也不该有 Node 权限（壳里没有 preload），
 * 所以文件由本地服务端出来，这里只是取。
 *
 * 【返回值是 `null` 而不是空数组】这两种情况必须分开：
 *  - `null` = **没有运行时目录**（普通浏览器、或壳没起来）→ 用打包进应用的那批；
 *  - `[]` = **有目录但是空的**（用户把文件都删了）→ 就该一个外置主题都没有。
 * 合并成一种的话，"删掉文件却还在"这种困惑会重新出现。
 *
 * 【拿不到就静默】超时同理：这是启动路径上的调用，宁可用打包的那份，也不让首屏
 * 等一个可能出问题的请求。
 */
export async function loadRuntimeThemes(
  builtin: readonly Theme[],
  options: { endpoint?: string; timeoutMs?: number } = {},
): Promise<Theme[] | null> {
  const endpoint = options.endpoint ?? RUNTIME_THEME_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 1500;

  try {
    const index = await fetch(`${endpoint}/index.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!index.ok) return null;

    const listing = (await index.json()) as { files?: unknown };
    const names = Array.isArray(listing.files)
      ? listing.files.filter((name): name is string => typeof name === 'string')
      : [];

    const files = await Promise.all(
      names.map(async (name): Promise<RawThemeFile | null> => {
        try {
          const response = await fetch(`${endpoint}/${encodeURIComponent(name)}`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) return null;
          return { label: `运行时主题 ${name}`, raw: await response.json() };
        } catch {
          // 单个文件读不动（坏 JSON、读一半被删）不该影响其它主题
          console.warn(`[themes] 运行时主题 ${name} 已忽略：读取失败`);
          return null;
        }
      }),
    );

    return themesFromFiles(files.filter((file): file is RawThemeFile => file !== null), builtin);
  } catch {
    // 没有这个端点（浏览器、或返回的不是 JSON）、读取超时：都当作"没有运行时目录"
    return null;
  }
}
