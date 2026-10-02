/**
 * 分层依赖检查（架构护栏）
 *
 * 单包项目没有 monorepo 的工作区机制来约束依赖方向，
 * 所以用这个零依赖脚本在 CI / 提交前强制 docs/01-architecture.md 里的依赖方向：
 *
 *   domain      → 只允许 shared / domain          （零外部依赖，不碰 React / 不碰 fetch）
 *   ports       → shared / domain
 *   application → shared / domain / ports
 *   adapters    → shared / domain / ports / application / adapters
 *   ui          → shared / domain / ports / application / ui    （不得直接依赖 adapters / bootstrap）
 *   bootstrap   → 任意（组合根特权）
 *
 * 【注意 adapters 允许 application】
 * 上面这份清单就是**代码里的 `ALLOWED`**，两边必须逐字一致 ——
 * 早先这里写的比代码严（漏了 application），结果注释成了"看起来更干净、
 * 实际不成立"的假约定，改代码的人反而被它误导。
 *
 * 用法：node scripts/check-layers.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** 每一层允许依赖的层 */
const ALLOWED = {
  domain: ['shared', 'domain'],
  ports: ['shared', 'domain', 'ports'],
  application: ['shared', 'domain', 'ports', 'application'],
  adapters: ['shared', 'domain', 'ports', 'application', 'adapters'],
  ui: ['shared', 'domain', 'ports', 'application', 'ui'],
  bootstrap: ['shared', 'domain', 'ports', 'application', 'adapters', 'ui', 'bootstrap'],
  // 入口文件等位于 src 根目录的文件视为组合根的一部分
  '(root)': ['shared', 'domain', 'ports', 'application', 'adapters', 'ui', 'bootstrap', '(root)'],
};

/** 别名 → 层名 */
const ALIASES = {
  '@shared': 'shared',
  '@domain': 'domain',
  '@ports': 'ports',
  '@app': 'application',
  '@adapters': 'adapters',
  '@ui': 'ui',
  '@bootstrap': 'bootstrap',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 由绝对路径推出所属层 */
function layerOfFile(absPath) {
  const rel = relative(SRC, absPath);
  if (rel.startsWith('..')) return '(root)';
  const segments = rel.split(sep);
  if (segments.length === 1) return '(root)';
  const first = segments[0];
  return first in ALLOWED ? first : '(root)';
}

/** 解析 import 说明符 → 目标层；返回 null 表示外部包（不检查） */
function layerOfSpecifier(specifier, fromFile) {
  for (const [alias, layer] of Object.entries(ALIASES)) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) return layer;
  }
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(fromFile), specifier);
    return layerOfFile(target);
  }
  return null; // 外部依赖
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function collectSpecifiers(source) {
  const found = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      found.push({ specifier: match[1], index: match.index });
    }
  }
  return found;
}

const violations = [];

for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8');
  const fromLayer = layerOfFile(file);
  const permitted = ALLOWED[fromLayer];
  if (!permitted) continue;

  for (const { specifier, index } of collectSpecifiers(source)) {
    const toLayer = layerOfSpecifier(specifier, file);
    if (toLayer === null) continue;
    if (permitted.includes(toLayer)) continue;

    const line = source.slice(0, index).split('\n').length;
    violations.push({
      file: relative(ROOT, file).replaceAll(sep, '/'),
      line,
      from: fromLayer,
      to: toLayer,
      specifier,
    });
  }
}

if (violations.length === 0) {
  console.log('[layers] ✅ 分层依赖检查通过，未发现越层引用');
  process.exit(0);
}

console.error(`[layers] ❌ 发现 ${violations.length} 处越层引用：\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    层次: ${v.from} → ${v.to}`);
  console.error(`    语句: import '${v.specifier}'`);
  console.error(`    允许: ${ALLOWED[v.from].join(' | ')}\n`);
}
process.exit(1);
