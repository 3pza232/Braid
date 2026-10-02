import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 版本号**只有一个来源**：package.json
 *
 * 组件里以前硬编码了一份"v0.1.0"，发版时忘了改就会与包里的版本对不上，
 * 排查问题（"用户说的这个版本"）时会直接误导人。注入进来就没有第二份可忘。
 */
const version = (JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string })
  .version;

/**
 * 给**构建产物**加一份内容安全策略
 *
 * 【为什么只加在构建产物上】开发服务器需要 HMR 的 WebSocket 与内联求值，
 * 同一份策略会把开发流程自己挡死（改了样式不生效、控制台一堆违规）。
 * 产物是静态的，没有这些需求。
 *
 * 【两条不能省的项】
 *  - `'unsafe-inline'`：`index.html` 里那段**防 FOUC 的内联脚本**与内联样式；
 *  - `'wasm-unsafe-eval'`：wa-sqlite 要编译 wasm，少这一项 SQLite 直接起不来。
 * 其余刻意收紧：不允许任何外部脚本、不允许 `<object>`、不允许注入 `<base>`。
 * `connect-src` 必须放开 http/https —— 模型端点与余额接口都是用户自己填的任意地址。
 *
 * 【怎么确认它没把应用挡坏】`npm run desktop:smoke` 会把渲染进程的报错（含 CSP 违规）
 * 带出来，并检查首屏与 OPFS。
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return {
    name: 'braid:csp',
    apply: 'build',
    transformIndexHtml: (html) => ({
      html,
      tags: [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ],
    }),
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@': r('./src'),
      '@shared': r('./src/shared'),
      '@domain': r('./src/domain'),
      '@ports': r('./src/ports'),
      '@app': r('./src/application'),
      '@adapters': r('./src/adapters'),
      '@ui': r('./src/ui'),
      '@bootstrap': r('./src/bootstrap'),
    },
  },
  server: {
    port: 5173,
    /*
     * 端口被占用时**直接失败**，而不是换一个
     * 失败会打印一行明确的报错，用户立刻知道要释放 5173 而不是去怀疑数据没了。
     */
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    /*
     * 资源用**相对路径**引用
     *
     * 默认的 `base: '/'` 会把 `index.html` 里的资源写成 `/assets/...` ——
     * 那种路径只有在"域名根目录"下才成立：桌面壳（Electron 打包的 exe）与
     * 直接打开 `dist/index.html` 都会解析到盘符根，**一打开就是白屏**。
     * 相对路径让产物在哪都能跑，不依赖任何部署假设。
     */
  },
  base: './',
});
