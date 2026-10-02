/**
 * 文档引用检查
 *
 * 【为什么需要】`docs/*.md` 与 `README.md` 里散落着大量对代码文件的引用
 * （`src/...`、`` `contextPlan.ts` `` 之类）。文件一旦改名或删除，这些引用会**静默失效** ——
 * 读者照着去找，全是空的；而 TypeScript 与测试都看不见 md 里的字。
 * 这类问题已经成片出现过一次（见 07-development.md 里那一轮清理），所以要有个门禁兜住。
 *
 * 【只在能判断的时候报错】误报会让门禁变成噪音，所以规则刻意保守：
 *  - 带目录的引用只认这几个顶层目录（`src/ tests/ scripts/ docs/ themes/ electron/`）；
 *  - 裸文件名只查源码类扩展名（`.ts/.tsx/.mjs/.css`），`README.md` 这种不查
 *    （文档里说的常常是"某个目录里的 README"，不是仓库根那个）；
 *  - **整段**里明说"不存在"的引用跳过 —— 正文里引用一个不存在的文件，正是为了指出这件事；
 *    按"段"而不是按"行"判断，是因为这种话常常跨行（文件清单在下一行），
 *    为了通过检查去把句子写别扭是本末倒置。
 * 运行不了（比如路径含通配）就跳过，绝不猜。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', '.codebuddy']);
const TOP_DIRS = ['src', 'tests', 'scripts', 'docs', 'themes', 'electron'];
/** 裸文件名只查这些扩展名 */
const SOURCE_EXT = /\.(ts|tsx|mjs|css)$/;
/** 行里明说目标不存在 → 那是"反面例子"，不是失效引用 */
const NEGATED = /不存在|没有的文件|已删除|已移除/;

function allFiles(dir = '.', out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(full, out);
    else out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

const files = allFiles();
const byName = new Set(
  files.filter((file) => SOURCE_EXT.test(file)).map((file) => file.split('/').pop()),
);

const docs = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.md')) docs.push(full.replace(/\\/g, '/'));
  }
})('docs');
docs.push('README.md');

const problems = [];
let checked = 0;

for (const doc of docs) {
  const lines = readFileSync(doc, 'utf8').split(/\r?\n/);
  /** 当前段落（连续的非空行）与它起始的行号 —— 否定语义按段判断，见文件头 */
  let paragraph = [];
  let paragraphStart = 1;

  const checkParagraph = () => {
    if (paragraph.length === 0) return;
    const negated = NEGATED.test(paragraph.join(' '));

    paragraph.forEach((line, offset) => {
      if (negated) return;

      const tokens = new Set();
      for (const m of line.matchAll(/(?:\.\.\/)*([a-z]+)\/[A-Za-z0-9_./-]+/g)) {
        if (TOP_DIRS.includes(m[1])) tokens.add(m[0]);
      }
      for (const m of line.matchAll(/`([A-Za-z0-9_-]+\.(?:ts|tsx|mjs|css))`/g)) {
        tokens.add(m[1]);
      }

      for (let token of tokens) {
        token = token.replace(/[.,;:)]+$/, '');
        if (token.includes('*')) continue;
        checked += 1;

        const clean = token.replace(/^(\.\.\/)+/, '');
        const ok = token.includes('/') ? existsSync(clean) : byName.has(token);
        if (!ok) problems.push(`${doc}:${paragraphStart + offset} → ${token}`);
      }
    });

    paragraph = [];
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      checkParagraph();
      return;
    }
    if (paragraph.length === 0) paragraphStart = index + 1;
    paragraph.push(line);
  });
  checkParagraph();
}

if (problems.length === 0) {
  console.log(`[docrefs] ✅ ${checked} 处文档引用都指向真实存在的文件`);
  process.exit(0);
}

console.error(`[docrefs] ❌ ${problems.length} 处引用指向不存在的文件：\n`);
for (const problem of problems) console.error(`  ${problem}`);
console.error('\n  两种处理：改名后把引用一起改掉；或这一处本来就是在说"它不存在"（那就在同一段里写明）。');
process.exit(1);
