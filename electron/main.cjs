/**
 * 桌面壳（Electron 主进程）
 *
 * 【它只做两件事】开一个窗口、把 `dist/` 通过本地 HTTP 端出来。
 * 应用本体是纯前端 + 浏览器本地存储（OPFS 上的 SQLite），所以这层壳刻意不碰业务：
 * 没有 preload、没有 IPC、渲染进程拿不到任何 Node 能力（`sandbox: true`）。
 *
 * 【为什么必须走 http 而不是 file://】
 * 两条都不认 `file://`：
 *  1. **OPFS 需要一个"非 opaque 的源"** —— `file://` 下 `navigator.storage.getDirectory()`
 *     会失败，于是应用会静默降级到内存库：界面一切正常，关掉再打开数据全没；
 *  2. wa-sqlite 的 `.wasm` 与模块 Worker 在 `file://` 下也会被拦。
 * 走 `http://127.0.0.1:<固定端口>` 就都成立了（本机地址算安全上下文）。
 *
 * 【为什么端口必须固定】OPFS 按**源**隔离，源里包含端口。
 * 端口一变，同一个应用会看到**另一个空的数据库** —— 用户的理解是"我的数据丢了"。
 * 所以这里用固定端口，并且靠 `requestSingleInstanceLock()` 保证只有一个实例：
 * 第二个实例不会起第二个服务，而是把已有窗口叫到前面来。
 *
 * 【用法】
 *   npm run desktop        —— 本地跑打包好的 dist
 *   npx electron . --smoke —— 自检：加载 → 探首屏与 OPFS → 打印结果 → 自行退出（0/1）
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/** 固定的本地端口：见文件头"为什么端口必须固定" */
const PORT = 41729;
const DIST = path.join(__dirname, '..', 'dist');
const INDEX = path.join(DIST, 'index.html');
const SMOKE = process.argv.includes('--smoke');

/**
 * 可拔插的主题目录：**exe 同级的 `themes/`**
 *
 * 放一个 JSON 进去、重启就能在设置里选到；删掉文件就真的没了。
 * 它由这个进程端出去（渲染进程没有 Node 权限），应用启动时按 `/_external-themes` 取。
 *
 * 【位置】打包后：**exe 同级的 `themes/`**（安装版装在哪，它就在哪）；
 * 开发态：直接用仓库里那份，开发者改的就是它。
 * 注：早先还支持便携版（那时要看 `PORTABLE_EXECUTABLE_DIR`，因为便携 exe 会把自己
 * 解到临时目录再跑）。现在只出安装版，那条分支就去掉了 —— 真要加回便携版记得一并处理。
 */
const THEME_DIR = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'themes')
  : // 开发态（`npm run desktop`）
    path.join(__dirname, '..', 'themes');
const THEME_PREFIX = '/_external-themes';
/** 只放行长得像主题文件的名字：这是唯一能读到磁盘任意位置的口子，必须窄 */
const THEME_FILE_NAME = /^[\w.-]+\.json$/;

/** 首次运行时写进主题目录的说明（让这个目录自己解释自己） */
const THEME_README = `# 主题目录（可拔插）

放在这里的 \`.json\` 会在应用启动时被读取，出现在「设置 → 外观」。
加一个文件就多一个主题，删掉文件就真的没了 —— 不需要改代码，也不需要重新打包。

格式（\`extends\` 必填，指向内置的基础主题）：

{
  "id": "my-theme",
  "name": "我的主题",
  "version": "1.0.0",
  "colorScheme": "dark",
  "extends": "braid.dark",
  "tokens": { "semantic": { "accent": { "default": "#FF6600" } } }
}

- \`id\` 唯一；\`colorScheme\` 取 \`light\` 或 \`dark\`（"跟随系统"时按它挑选）；
- 只写要覆盖的 token，其余从基础主题继承；
- 写坏了不会白屏：那个文件会被跳过，原因留在控制台里。

改完主题**重启应用**生效。
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 主题目录：不存在就建，并**只在首次**把打包进应用的示例主题与说明拷进去
 *
 * 为什么带示例：用户打开这个目录要能看懂格式（看到 6 个真实文件比看文档快）。
 * 为什么只在首次：`themes/` 是用户的目录 —— 他删掉 `ocean.json` 之后，
 * 应用不该每次启动都把它塞回来（那就成了"删不掉的示例"）。
 *
 * 拷不出来只警告：主题是锦上添花，不该让应用起不来。
 */
function ensureThemeDirectory() {
  try {
    if (fs.existsSync(THEME_DIR)) return;
    fs.mkdirSync(THEME_DIR, { recursive: true });

    // 示例在打包产物里（asar 内）。读出来再写出去：跨 asar 的复制用读+写最稳。
    const samples = path.join(__dirname, '..', 'themes');
    for (const name of fs.readdirSync(samples)) {
      if (!name.endsWith('.json')) continue;
      fs.writeFileSync(path.join(THEME_DIR, name), fs.readFileSync(path.join(samples, name)));
    }
    fs.writeFileSync(path.join(THEME_DIR, 'README.md'), THEME_README, 'utf8');
  } catch (error) {
    console.warn(`[themes] 主题目录准备失败（不影响其它功能）：${String(error)}`);
  }
}

/** 主题目录的文件清单（只列 .json，按名字排序以便两次结果可比） */
function themeFileNames() {
  try {
    return fs.readdirSync(THEME_DIR).filter((name) => THEME_FILE_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * 把 `dist/` 与主题目录端出去
 *
 * 刻意不引第三方静态服务器：需要的只是"按扩展名给对 MIME"这一件事，
 * 而 `.wasm` 的 MIME 给错会让 wa-sqlite 起不来 —— 自己写反而更看得清。
 * 主题那条路由也在这里（渲染进程读不到磁盘，只能这样把用户的主题交给它）。
 */
function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);

    // ── 主题目录：清单 ──
    if (pathname === `${THEME_PREFIX}/index.json`) {
      const body = JSON.stringify({ files: themeFileNames(), dir: THEME_DIR });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    // ── 主题目录：单个文件（名字必须先过白名单，杜绝 ../ 之类的路径）──
    if (pathname.startsWith(`${THEME_PREFIX}/`)) {
      const name = pathname.slice(THEME_PREFIX.length + 1);
      const file = path.join(THEME_DIR, name);
      if (!THEME_FILE_NAME.test(name) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(response);
      return;
    }

    let file = path.join(DIST, pathname);
    // 目录穿越防护：解析后必须仍在 dist 之内
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = INDEX;

    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 自检：把"渲染进程真的把应用跑起来了"这件事变成一个可判断的返回值 */
async function smokeTest(window) {
  const problems = [];
  window.webContents.on('did-fail-load', (_event, code, description) => {
    problems.push(`页面加载失败：${code} ${description}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    problems.push(`渲染进程退出：${details.reason}`);
  });
  // 渲染进程里的报错（含 CSP 违规）也要带出来，否则"白屏"没有任何线索
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') problems.push(`控制台错误：${event.message}`);
  });

  await window.loadURL(`http://127.0.0.1:${PORT}/`);
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const probe = await window.webContents.executeJavaScript(`(async () => {
    const root = await navigator.storage.getDirectory().then(() => true).catch(() => false);
    return {
      title: document.title,
      elements: document.querySelectorAll('*').length,
      firstScreen: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120),
      opfs: root,
      secure: window.isSecureContext,
      // 内联脚本有没有被 CSP 挡掉：它负责在 React 挂载前写上主题标记
      theme: document.documentElement.dataset.theme ?? '',
    };
  })()`);

  console.log(`[smoke] ${JSON.stringify(probe)}`);

  /*
   * 主题目录的"可拔插"要真的验证：不是看目录存在，而是
   * **临时丢一个文件进去，看它有没有出现在清单里** —— 那正是用户做的事。
   */
  const readThemeIndex = () =>
    window.webContents.executeJavaScript(
      `fetch('${THEME_PREFIX}/index.json').then((r) => r.json()).then((j) => j.files).catch(() => null)`,
    );

  const themesBefore = (await readThemeIndex()) ?? [];
  console.log(`[smoke] 主题目录 ${THEME_DIR} → ${themesBefore.length} 个文件`);
  if (themesBefore.length === 0) problems.push('主题目录是空的（首次运行应当已拷入示例主题）');

  const probeFile = 'smoke-probe.json';
  try {
    fs.writeFileSync(
      path.join(THEME_DIR, probeFile),
      JSON.stringify({
        id: 'smoke-probe',
        name: '自检主题',
        version: '1.0.0',
        colorScheme: 'dark',
        extends: 'braid.dark',
        tokens: {},
      }),
      'utf8',
    );
    const themesAfter = (await readThemeIndex()) ?? [];
    if (!themesAfter.includes(probeFile)) {
      problems.push('可拔插验证失败：新放进主题目录的文件没有被列出');
    } else {
      console.log('[smoke] 新放入的主题文件已被列出 ✓');
    }
  } finally {
    // 自检不该在用户的目录里留下东西
    try {
      fs.rmSync(path.join(THEME_DIR, probeFile), { force: true });
    } catch {
      /* 删不掉也只是多一个 1KB 的文件 */
    }
  }
  if (probe.elements < 20) problems.push('首屏几乎是空的（React 没挂载或崩了）');
  if (!probe.opfs) problems.push('OPFS 不可用 —— 数据不会落盘（这正是必须避免的那件事）');
  if (!probe.secure) problems.push('不是安全上下文');

  /*
   * CSP 里必须允许 eval：**余额脚本功能就是"执行用户写的 JS"**（`new Function`）。
   *
   * 少这一项时，CSP 只在**产物**里生效 —— 浏览器里开发一切正常，装进 exe 就坏，
   * 而且坏在"用户配置里的一个功能"上（首屏照常渲染，看不出来）。这个坑真的踩过一次，
   * 所以这里实际执行一次 `new Function`，而不是只看 CSP 文本里有没有那串字。
   */
  const evalResult = await window.webContents.executeJavaScript(
    `(() => { try { return new Function('return 1')() } catch (e) { return 'BLOCKED: ' + String(e) } })()`,
  );
  if (evalResult !== 1) {
    problems.push(`CSP 不允许 eval（余额脚本会失效）：${evalResult}`);
  } else {
    console.log('[smoke] eval 可用（余额脚本能执行）✓');
  }

  for (const problem of problems) console.error(`[smoke] ✗ ${problem}`);
  console.log(problems.length === 0 ? '[smoke] ✅ 通过' : `[smoke] ❌ ${problems.length} 项问题`);
  return problems.length === 0;
}

/** 第二个实例：不起服务、不建窗口，把已有窗口叫到前面来 */
// 自检模式不抢锁：应用正开着时也要能跑（那时它会去争同一个端口，走下面的报错分支）
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    if (!fs.existsSync(INDEX)) {
      dialog.showErrorBox('缺少构建产物', `找不到 ${INDEX}\n请先执行 npm run build。`);
      app.exit(1);
      return;
    }

    // 先把主题目录准备好：服务要端它，应用启动的第一个请求就会来取
    ensureThemeDirectory();

    try {
      await startServer();
    } catch (error) {
      const message =
        `无法监听 127.0.0.1:${PORT}（${String(error)}）。` +
        `这个端口是固定用的：换端口会让应用看到另一个空数据库。请先关掉占用它的程序。`;
      // 自检模式只往 stderr 写：弹窗会让自动化永远等下去
      if (SMOKE) console.error(`[smoke] ✗ ${message}`);
      else dialog.showErrorBox('端口被占用', message);
      app.exit(1);
      return;
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      show: !SMOKE,
      title: 'Braid',
      // 渲染进程不需要任何 Node 能力：没有 preload、没有 IPC
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    // 应用里不该出现"应用内打开网页"；真有外链就交给系统浏览器
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    if (SMOKE) {
      app.exit((await smokeTest(window)) ? 0 : 1);
      return;
    }

    await window.loadURL(`http://127.0.0.1:${PORT}/`);
  });

  app.on('window-all-closed', () => app.quit());
}
