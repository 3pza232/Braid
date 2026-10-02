/**
 * 死代码扫描（**阻断构建**）
 *
 * 做法：收集 src 下所有「导出名」，再统计每个名字在本文件之外出现过的次数。
 * 次数为 0 的即为疑似死导出。
 *
 * 【为什么从"只打印"改成"阻断"】
 * 不阻断的门禁约等于没有门禁 —— 它只出现在日志里，而没人会每次去翻日志。
 * 而"删了调用方、忘了删导出"恰恰是最容易悄悄堆积的一类：单个无害，
 * 攒起来就是"不知道哪些是活的"。
 *
 * 扫描是近似的（不做语义分析），所以确实存在"故意导出、暂时无人引用"的情况
 * （扩展点、给外部用的入口）。这种要**显式声明**：在声明那一行加
 * `// @dead-export-ok: 理由`。显式声明比"让门禁永远只打印"诚实 ——
 * 前者要求人写下一句话，后者等于放弃检查。
 *
 * 用法：node scripts/check-dead.mjs
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

const files = walk(SRC);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

/** 收集导出名 → 声明它的文件 */
const exportsByName = new Map();

const DECL_RE =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const LIST_RE = /export\s+(?:type\s+)?\{([^}]*)\}/g;

for (const [file, source] of sources) {
  for (const re of [DECL_RE, LIST_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const raw = match[1];
      for (const piece of raw.split(',')) {
        const name = piece.split(/\s+as\s+/).pop()?.trim();
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const owner = exportsByName.get(name);
        if (owner) owner.add(file);
        else exportsByName.set(name, new Set([file]));
      }
    }
  }
}

const dead = [];

for (const [name, owners] of exportsByName) {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
  let uses = 0;

  for (const [file, source] of sources) {
    const matches = source.match(pattern);
    if (!matches) continue;
    // 声明处自己出现的那一次不算使用
    const ownCount = owners.has(file) ? (file === [...owners][0] ? 1 : 0) : 0;
    uses += matches.length - ownCount;
  }

  if (uses <= 0) {
    dead.push({ name, files: [...owners].map((f) => relative(ROOT, f).replaceAll(sep, '/')) });
  }
}

/** 收集显式声明保留的导出名（声明行带 `@dead-export-ok`） */
const allowed = new Set();
for (const source of sources.values()) {
  for (const line of source.split('\n')) {
    if (!line.includes('@dead-export-ok')) continue;
    for (const re of [DECL_RE, LIST_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        for (const piece of match[1].split(',')) {
          const name = piece.split(/\s+as\s+/).pop()?.trim();
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) allowed.add(name);
        }
      }
    }
  }
}

const problems = dead.filter((item) => !allowed.has(item.name));

if (problems.length === 0) {
  const kept = dead.length - problems.length;
  console.log(`[dead] ✅ 未发现未被使用的导出${kept > 0 ? `（其中 ${kept} 个已显式声明保留）` : ''}`);
  process.exit(0);
}

console.error(`[dead] ❌ ${problems.length} 个导出在本文件之外没有任何引用：\n`);
for (const item of problems.sort((a, b) => a.name.localeCompare(b.name))) {
  console.error(`  ${item.name}`);
  for (const file of item.files) console.error(`      ${file}`);
}
console.error('\n两种处理：确实不需要就删掉；确实要留（扩展点 / 给外部用）就在声明那一行加');
console.error('`// @dead-export-ok: 理由` 显式声明，让"为什么留着"留在代码里。');
process.exit(1);
