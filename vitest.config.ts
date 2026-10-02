import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/** 与 vite.config.ts 同一份来源：组件里用的 `__APP_VERSION__` 由构建期注入 */
const version = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * 测试配置
 *
 * 【为什么测试放在根目录的 tests/ 而不是与源码同目录】
 * 分层检查（check-layers）扫描的是 src/，而**跨层测试**是合法且必要的 ——
 * 例如"ChatService + 假仓储 + 真领域规则"这种端到端用例本来就要同时碰
 * application、adapters 与 domain。放进 src/ 会被分层检查误伤，放在外面两清。
 *
 * 别名必须与 tsconfig.json 的 paths 保持一致：一边改了两边不改，
 * 就会出现"IDE 里能跳转、测试里找不到模块"的怪事。
 */
export default defineConfig({
  // 「关于」分区会渲染 `__APP_VERSION__`：测试环境也必须注入，否则那是 ReferenceError
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      '@shared': path.resolve(root, 'src/shared'),
      '@domain': path.resolve(root, 'src/domain'),
      '@ports': path.resolve(root, 'src/ports'),
      '@app': path.resolve(root, 'src/application'),
      '@adapters': path.resolve(root, 'src/adapters'),
      '@ui': path.resolve(root, 'src/ui'),
      '@bootstrap': path.resolve(root, 'src/bootstrap'),
    },
  },
  test: {
    /*
     * 默认跑在 node 环境：绝大多数测试是纯逻辑，不需要 DOM，也就更快。
     *
     * UI 测试要 jsdom，靠文件顶部的 `// @vitest-environment jsdom` **按需切换** —— 
     * 全局切成 jsdom 会让纯逻辑测试也跟着付一份 DOM 环境的代价。
     * 所以 `include` 里同时收 `.ts` 与 `.tsx`（组件测试需要 JSX）。
     */
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
