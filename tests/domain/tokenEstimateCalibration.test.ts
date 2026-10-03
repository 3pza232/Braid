import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@domain/value-objects/usage';

/**
 * `estimateTokens` 的**校准**（拿官方 tokenizer 的实测值当标尺）
 *
 * 【为什么值得单独钉住】它是启发式（汉字 ×0.7 + 其他 ×0.25），而同一个系数同时喂着三处：
 * **上下文预算 / 压缩触发线 / 界面上的"约 N token"**。错了是系统性的、而且"看起来很合理"——
 * 早先用的 1.7 来自"1 字约 1.5~1.7 token"这个**旧一代 tokenizer** 的说法，
 * 实测**平均高估 89%**（中文小说 +145%、系统提示词 +141%），代价是动不动就压缩、白丢历史，
 * 以及用户看到的估算数字离谱（真实反馈："几乎每次都多很多甚至翻一倍"）。
 *
 * 【下面这些数字从哪来】用 DeepSeek 官方发布的离线 tokenizer（`tokenizer.json`，
 * BPE / vocab 128k / merges 12.7 万）**逐条量**出来的，2026-10。
 *
 * 注意：那份包里附带的 `deepseek_tokenizer.py`（走 `AutoTokenizer`）**对中文返回空**，
 * 得用底层 `tokenizers.Tokenizer.from_file()` 才是对的 —— 用它当标尺会得出完全相反的结论。
 *
 * 【容差为什么这么宽】这是**按语言统计**的系数，不是某个模型的词表，所以只要求"量级正确"。
 * 30% 足以挡住"把系数调回 1.5~1.7"那类改动（那会让下面一片全红）。
 */
const CASES: Array<{ label: string; text: string; official: number }> = [
  {
    label: '中文小说段落',
    text:
      '她把信纸折好，塞回那个已经磨破角的信封里。窗外的雨还在下，雨点敲在铁皮雨棚上，' +
      '像有人在上面走。她忽然想起很多年前的那个下午，也是这样的雨，也是这样的信。',
    official: 53,
  },
  {
    label: '系统提示词片段',
    text:
      '你是 Braid，一个写作与编程的助手。当前用户名叫「阿澈」，角色名叫「灯里」。\n' +
      '写小说时保持人称与时态一致，不要复述已写内容。',
    official: 41,
  },
  {
    label: 'Markdown 混排（中文 + 代码）',
    text: [
      '## 说明',
      '',
      '这个函数会把 `text` 按字符类别估算：',
      '',
      '```ts',
      'export function estimateTokens(text: string): number {',
      '  return 0;',
      '}',
      '```',
      '',
      '注意它**只是估算**，精度约 ±15%。',
    ].join('\n'),
    official: 48,
  },
  {
    label: '工具参数 JSON（中英混排）',
    text: '{"path":"小说/第一章.txt","content":"她抬起手，停了一下。"}',
    official: 18,
  },
  {
    label: '英文段落',
    text:
      'She folded the letter and put it back into the worn envelope. ' +
      'Outside, the rain was still falling, drumming on the tin canopy like footsteps.',
    official: 30,
  },
];

describe('estimateTokens 的校准（对照官方 tokenizer 实测值）', () => {
  it.each(CASES)('$label：估算与实测相差不到 30%', ({ text, official }) => {
    const estimated = estimateTokens(text);
    const error = Math.abs(estimated / official - 1);
    expect(error, `估 ${estimated} vs 实测 ${official}`).toBeLessThan(0.3);
  });

  it('整批的平均绝对误差 < 15%（早先用 1.7 时是 89%）', () => {
    const errors = CASES.map(({ text, official }) => Math.abs(estimateTokens(text) / official - 1));
    const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    expect(mean).toBeLessThan(0.15);
  });

  it('中文绝不再是"1 字 2 token 级"的高估（这条挡住历史回退）', () => {
    const text = '她把信纸折好塞回那个已经磨破角的信封里';
    // 实测约 0.75 token/字；给足余量，但"超过 1.2 倍字符数"就说明又被调回旧系数了
    expect(estimateTokens(text)).toBeLessThan(text.length * 1.2);
  });
});
