/**
 * CSS 纪律检查
 *
 * 三类问题，都是"静默生效、出事很难查"的：
 *  1. 代码里用了 `styles.foo`，但 .module.css 里没有 `.foo`
 *     —— 会被解析成 undefined，className 静默失效，界面上看不出报错；
 *  2. .module.css 里定义了类，但没有任何代码使用
 *     —— 死样式，会让文件越来越脏；
 *  3. `z-index` 写了裸数字或用了不存在的 token
 *     —— 裸数字会**跨层生效**：一个硬编码的 6 就能让消息区里的浮动按钮
 *        盖住设置面板（真实发生过，而且代码上完全看不出来）。
 *        token 名写错更隐蔽：`var(--z-popover)` 这种不存在的名字会静默失效，
 *        一眼看去"用了 token"，实际上什么都没生效。
 *
 * 用法：node scripts/check-styles.mjs  （发现第 1、3 类问题时以非零码退出）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 从选择器里提取类名（先去掉注释，再只取每个 `{` 之前的那一段选择器） */
function classesOfCss(file) {
  const raw = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();

  for (const chunk of raw.split('{').slice(0, -1)) {
    const selector = chunk.slice(Math.max(chunk.lastIndexOf('}'), chunk.lastIndexOf(';')) + 1);
    for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}

/**
 * z-index 允许出现的 token —— 与 src/adapters/themes/primitives.ts 的 zIndex 一一对应
 *
 * 这里刻意**硬编码一份清单**而不是去解析那个 TS 文件：清单是"契约"，
 * 多一处引用就多一处会悄悄失同步的解析逻辑；而契约变了本来就该有人来改这里。
 */
const Z_TOKENS = new Set(['base', 'dropdown', 'sticky', 'overlay', 'modal', 'toast', 'tooltip']);

/** 收集 src 下所有样式表（含全局样式：层叠纪律对它们同样适用） */
function cssFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') cssFiles(full, out);
    } else if (entry.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

const zProblems = [];

for (const file of cssFiles(SRC)) {
  // 注释里的示例不该被当成违规
  const lines = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
  lines.forEach((line, index) => {
    const match = line.match(/z-index:\s*([^;]+)/);
    if (!match) return;
    const value = match[1].trim();

    const token = value.match(/^var\(\s*--z-([\w-]+)\s*\)$/);
    if (!token) {
      zProblems.push({ file, line: index + 1, reason: `必须用 var(--z-*) token，现在是 \`${value}\`` });
    } else if (!Z_TOKENS.has(token[1])) {
      zProblems.push({ file, line: index + 1, reason: `没有 --z-${token[1]} 这个 token` });
    }
  });
}

const missing = [];
let checked = 0;

/** cssFile → 所有导入方用到的类名并集 */
const usageByModule = new Map();

for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8');
  const importMatch = source.match(
    /import\s+(\w+)\s+from\s+['"](\.[^'"]+\.module\.css)['"]/,
  );
  if (!importMatch) continue;

  const [, localName, specifier] = importMatch;
  const cssFile = resolve(dirname(file), specifier);

  let defined;
  try {
    defined = classesOfCss(cssFile);
  } catch {
    continue;
  }
  checked += 1;

  const used = new Set();
  for (const match of source.matchAll(
    new RegExp(`\\b${localName}\\.([A-Za-z_][\\w]*)|\\b${localName}\\['([^']+)'\\]`, 'g'),
  )) {
    used.add(match[1] ?? match[2]);
  }

  // 「用了但没定义」必须按**导入方**判定：这是那个文件自己的引用错误
  for (const name of used) {
    if (!defined.has(name)) {
      missing.push({ file, name, cssFile });
    }
  }

  const union = usageByModule.get(cssFile) ?? new Set();
  for (const name of used) union.add(name);
  usageByModule.set(cssFile, union);
}

/*
 * 死样式**按模块聚合后**再判定
 *
 * 早先是"逐个导入方比一次"，那隐含了「一个 module 只被一个文件导入」这个前提。
 * 一旦多个文件共享同一个 module（设置面板拆出的各分区共用 `sections.module.css`
 * 就是这种情况），每个类的使用记录都落在**别的**导入方身上，
 * 于是报出"文件数 × 类数"条假死样式 —— 门禁一吵，真问题就没人看了。
 */
const unused = [];
for (const [cssFile, used] of usageByModule) {
  let defined;
  try {
    defined = classesOfCss(cssFile);
  } catch {
    continue;
  }
  for (const name of defined) {
    if (!used.has(name)) unused.push({ cssFile, name });
  }
}

const rel = (p) => relative(ROOT, p).replaceAll(sep, '/');

/*
 * 死样式的显式豁免
 *
 * 与 `check:dead` 同一套写法：确实要留着（为将来准备的公共类）就在那条规则的
 * 同一行写 `/* @dead-style-ok: 理由 *\/`，让"为什么留着"留在样式里。
 *
 * 【为什么从"只提示"改成阻断】
 * 只提示等于没有门禁：死样式会一直躺着，而它每一轮拆分/改名都会被重新算一遍
 *（本项目已经踩过：拆分设置面板时，一个模块被多文件共享，死样式被重复报了几十条，
 * 那时"提示"就已经没人看了）。豁免通道保证"确实要留"仍有余地。
 */
const allowedDead = new Set();
for (const cssFile of usageByModule.keys()) {
  let source;
  try {
    source = readFileSync(cssFile, 'utf8');
  } catch {
    continue;
  }
  for (const line of source.split('\n')) {
    if (!line.includes('@dead-style-ok')) continue;
    const match = line.match(/\.([A-Za-z_][\w-]*)/);
    if (match) allowedDead.add(match[1]);
  }
}

const blockedStyles = unused.filter((item) => !allowedDead.has(item.name));

if (blockedStyles.length > 0) {
  console.error(`[styles] ❌ ${blockedStyles.length} 个 CSS 类定义了却没被用到（死样式）：\n`);
  for (const item of blockedStyles) {
    console.error(`  ${rel(item.cssFile)} → .${item.name}`);
  }
  console.error('');
  console.error('  两种处理：不需要就删掉；确实要留（为将来准备的公共类）就在那条规则那一行加');
  console.error('  `/* @dead-style-ok: 理由 *\/` 显式声明，让"为什么留着"留在样式里。');
  console.error('');
}

if (zProblems.length > 0) {
  console.error(`[styles] ❌ ${zProblems.length} 处 z-index 不合规：\n`);
  for (const item of zProblems) {
    console.error(`  ${rel(item.file)}:${item.line}`);
    console.error(`      ${item.reason}\n`);
  }
}

if (missing.length === 0 && zProblems.length === 0 && blockedStyles.length === 0) {
  console.log(`[styles] ✅ ${checked} 组 CSS Module 引用全部有定义，z-index 全部走 token`);
  process.exit(0);
}

console.error(`[styles] ❌ ${missing.length} 处 styles.xxx 在 CSS 里没有定义：\n`);
for (const item of missing) {
  console.error(`  ${rel(item.file)}`);
  console.error(`      styles.${item.name}  →  ${rel(item.cssFile)} 中不存在\n`);
}
process.exit(1);
