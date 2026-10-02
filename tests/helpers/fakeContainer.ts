import { builtinThemes, createThemeRegistry } from '@adapters/themes';
import { ChatService } from '@app/chat/ChatService';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { AppContainer } from '@ports/AppContainer';
import { ok } from '@shared/result';
import { createFakeProvider, createFakeWorkspace, createSettings, createStores } from './chatHarness';

/**
 * 界面测试用的假容器
 *
 * 【为什么要"搭一个容器"才能测组件】
 * 组件不直接 new 适配器，而是通过 `useContainer()` 拿依赖 —— 这是依赖倒置的代价：
 * 测界面就必须提供一个容器。好在容器是**接口**，所以这里给的都是最小实现。
 *
 * 原则：**渲染路径上用到的必须是真的**（如主题注册表 —— 少了它 ThemeProvider 起不来），
 * 只有"点了才会用到"的才允许是空壳（角色、余额、备份）。这样冒烟测试测的是
 * 真实的渲染路径，而不是"什么依赖都没给，所以什么都没发生"。
 */
export function createFakeContainer(): AppContainer {
  const { store, messages } = createStores();
  const workspace = createFakeWorkspace();
  const settings = createSettings();
  const { provider } = createFakeProvider([]);

  // 真服务 + 假仓储：这样面板里任何"读一下当前会话/设置"的渲染路径都走真实逻辑
  const chat = new ChatService(
    store,
    messages,
    settings,
    provider,
    createWorkspaceToolRegistry(workspace.api),
  );

  return {
    // 真实的注册表与内置主题：ThemeProvider 会据此写入 CSS 变量
    themes: createThemeRegistry(builtinThemes),
    settings,
    chat,
    workspace: workspace.api,
    provider,
    // 以下都是"只有交互才会碰到"的端口，给最小空壳即可（类型由断言收窄）
    roles: {} as never,
    balance: {} as never,
    backup: {} as never,
    fileDialog: {
      openText: async () => ok(null),
      saveText: async () => ok(null),
    } as never,
    // 多标签页协调只在入口（main.tsx）用到，不在渲染路径上：给个"不支持"即可
    instanceLock: { role: async () => 'unsupported' } as never,
    sql: {} as never,
    storageReady: Promise.resolve({
      engine: 'memory',
      durable: false,
      path: '(test)',
      schemaVersion: 0,
      conversations: 0,
      messages: 0,
      roles: 0,
      error: null,
    } as never),
  };
}

/**
 * jsdom 缺失的浏览器 API
 *
 * jsdom 不实现 `matchMedia` 与 `ResizeObserver`，而主题 provider 与部分组件会用到。
 * 补桩放在夹具里而不是各个测试文件里：漏一个就会得到一个"莫名其妙就炸了"的报错。
 */
export function installBrowserStubs(): void {
  if (typeof window === 'undefined') return;

  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}
