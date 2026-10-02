import { createContext, useContext, type ReactNode } from 'react';
import type { AppContainer } from '@ports/AppContainer';
import { ThemeProvider } from '@ui/theme/ThemeProvider';

const ContainerContext = createContext<AppContainer | null>(null);

/**
 * 依赖注入的 React 桥接层
 *
 * 组合根在 main.tsx 里只执行一次，之后整棵组件树通过 context 拿到 container。
 * 组件因此永远不会直接 new 一个适配器，也不会直接 import 适配层 ——
 * 这一点由 `scripts/check-layers.mjs` 在 `npm run verify` 里强制
 * （仓库没有 ESLint，别指望 lint 规则替你拦）。
 */
export function BraidProvider({
  container,
  children,
}: {
  container: AppContainer;
  children: ReactNode;
}) {
  return (
    <ContainerContext.Provider value={container}>
      <ThemeProvider themes={container.themes}>{children}</ThemeProvider>
    </ContainerContext.Provider>
  );
}

export function useContainer(): AppContainer {
  const ctx = useContext(ContainerContext);
  if (!ctx) throw new Error('[di] useContainer 必须在 <BraidProvider> 内使用');
  return ctx;
}
