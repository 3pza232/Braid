import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinThemes } from '@adapters/themes';
import { loadRuntimeThemes } from '@adapters/themes/externalThemes';

/**
 * 运行时主题目录（桌面版：exe 同级的 `themes/`）
 *
 * 这条路径上有两个**必须分清**的状态，混掉任何一个都会让用户困惑：
 *  - 没有这个目录（普通浏览器）→ `null` → 用打包进应用的那批主题；
 *  - 有目录但里面是空的（用户把文件都删了）→ `[]` → 就是一个外置主题都没有。
 * 合并成一种的话，"我删了它怎么还在"会重新出现 —— 而那正是这个功能要解决的。
 *
 * 另外每条"坏文件"的分支都必须只影响它自己：一个手滑写错的 JSON 不该让别的主题消失。
 */
const ENDPOINT = '/_external-themes';
const themeFile = (name: string, patch: Record<string, unknown> = {}) => ({
  id: name.replace(/\.json$/, ''),
  name: `主题 ${name}`,
  version: '1.0.0',
  colorScheme: 'dark',
  extends: 'braid.dark',
  tokens: {},
  ...patch,
});

/** 按 URL 路由的假 fetch：没配的路径一律 404（模拟"端点不存在"） */
function installFetch(routes: Record<string, () => Response | Promise<Response>>): void {
  globalThis.fetch = (async (input: unknown) => {
    const route = routes[String(input)];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const load = () => loadRuntimeThemes(builtinThemes, { endpoint: ENDPOINT });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadRuntimeThemes', () => {
  it('没有这个端点（普通浏览器）：返回 null，调用方会用打包的那批', async () => {
    installFetch({});

    await expect(load()).resolves.toBeNull();
  });

  it('目录存在但为空：返回 []，**不退回**内置示例（"删掉了就该没有"）', async () => {
    installFetch({ [`${ENDPOINT}/index.json`]: () => json({ files: [] }) });

    await expect(load()).resolves.toEqual([]);
  });

  it('读到一个合法文件：变成可用的主题', async () => {
    installFetch({
      [`${ENDPOINT}/index.json`]: () => json({ files: ['ocean.json'] }),
      [`${ENDPOINT}/ocean.json`]: () => json(themeFile('ocean.json', { name: '海洋' })),
    });

    const themes = await load();

    expect(themes).toHaveLength(1);
    expect(themes?.[0]).toMatchObject({ id: 'ocean', name: '海洋' });
    // 继承自基础主题的 token 必须在（说明走的是同一套深合并）
    expect(themes?.[0]?.tokens).toBeTruthy();
  });

  it('extends 认不出来：只跳过那一个，其余照常装载', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installFetch({
      [`${ENDPOINT}/index.json`]: () => json({ files: ['bad.json', 'good.json'] }),
      [`${ENDPOINT}/bad.json`]: () => json(themeFile('bad.json', { extends: '不存在的主题' })),
      [`${ENDPOINT}/good.json`]: () => json(themeFile('good.json')),
    });

    const themes = await load();

    expect(themes?.map((theme) => theme.id)).toEqual(['good']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('坏 JSON（拿到的不是 JSON）：跳过它，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installFetch({
      [`${ENDPOINT}/index.json`]: () => json({ files: ['broken.json', 'good.json'] }),
      [`${ENDPOINT}/broken.json`]: () => new Response('{ 这不是 JSON', { status: 200 }),
      [`${ENDPOINT}/good.json`]: () => json(themeFile('good.json')),
    });

    const themes = await load();

    expect(themes?.map((theme) => theme.id)).toEqual(['good']);
  });

  it('某个文件 404：其它主题照常装载', async () => {
    installFetch({
      [`${ENDPOINT}/index.json`]: () => json({ files: ['missing.json', 'good.json'] }),
      [`${ENDPOINT}/good.json`]: () => json(themeFile('good.json')),
    });

    const themes = await load();

    expect(themes?.map((theme) => theme.id)).toEqual(['good']);
  });

  it('清单形状不对（files 不是数组）：当作空的，不抛', async () => {
    installFetch({ [`${ENDPOINT}/index.json`]: () => json({ files: 'ocean.json' }) });

    await expect(load()).resolves.toEqual([]);
  });

  it('整个请求失败（网络异常）：返回 null —— 启动路径上的调用不许抛', async () => {
    installFetch({
      [`${ENDPOINT}/index.json`]: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await expect(load()).resolves.toBeNull();
  });
});
