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
 * 【三项不能省的】
 *  - `'unsafe-inline'`：`index.html` 里那段**防 FOUC 的内联脚本**与内联样式；
 *  - `'unsafe-eval'`：**余额脚本功能就是"执行用户写的 JS"**（`new Function`，
 *    见 adapters/balance/scriptBalanceProvider.ts）。少这一项时，CSP 只在**产物**里生效，
 *    于是"浏览器里好好的、装进 exe 就报错" —— 这个坑已经踩过一次，别再删它；
 *  - `'wasm-unsafe-eval'`：wa-sqlite 要编译 wasm，少这一项 SQLite 直接起不来。
 *
 * 允许了 inline 与 eval，脚本层面的防护就只剩"不允许加载外部脚本"这类粗线；
 * 但对这个应用是合理的取舍：它**本来就要跑用户自己写的余额脚本**，
 * 而那部分能力是功能，不是漏洞。剩下的项仍然值得留着：不允许任何外部脚本源、
 * 不允许 `<object>`、不允许注入 `<base>`、`img-src` 收到 self/data/blob/https、
 * `connect-src` 放开 http/https（模型端点与余额接口都是用户自己填的任意地址）。
 *
 * 【怎么确认它没把应用挡坏】`npm run desktop:smoke` 会：把渲染进程的报错（含 CSP 违规）
 * 带出来、探首屏与 OPFS、验主题目录，并**实际执行一次 `new Function`** 确认 eval 没被拦。
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
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
