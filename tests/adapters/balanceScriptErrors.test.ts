import { describe, expect, it } from 'vitest';
import { createScriptBalanceProvider } from '@adapters/balance/scriptBalanceProvider';

/**
 * 余额脚本失败时**说什么**
 *
 * 这条文案关系到用户会不会被送去查错地方。真实发生过：产物的 CSP 少了 `'unsafe-eval'`，
 * 于是 `new Function` 被环境拒绝，而当时的代码把**任何**异常都说成
 * "余额脚本无法解析，请检查括号与引号是否配对" —— 用户拿着一个完全正确的脚本找括号。
 *
 * 所以规则是：**语法错才说语法**，其它一律说清是环境拒绝执行。
 */
const provider = createScriptBalanceProvider();
const context = { apiKey: 'k', baseUrl: 'https://example.test/v1', timeoutMs: 100 };

describe('余额脚本的报错文案', () => {
  it('脚本语法真的错了：说"检查括号与引号"（这句话本身是对的）', async () => {
    const result = await provider.probe('{ request: { url: "x" ', context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('括号与引号');
  });

  it('环境拒绝执行（eval 被 CSP 拦下）：说清是环境，不把用户送去查括号', async () => {
    /*
     * jsdom 里没法真的触发 CSP，所以用一个**语法完全正确、执行时抛 EvalError** 的脚本
     * 覆盖同一个分支 —— 浏览器在 CSP 拦下 `new Function` 时抛的正是这类非语法异常。
     * 这条用例验的是"分支判对了"，不是"CSP 真的会拦"（那件事由 desktop:smoke 在产物上验）。
     */
    const result = await provider.probe(
      '(() => { throw new EvalError("Refused to evaluate a string as JavaScript") })()',
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('环境拒绝执行');
    expect(result.error.message).not.toContain('括号');
    // 原始信息要留着：它才说得出"是哪条策略挡的"
    expect(result.error.detail).toContain('Refused to evaluate');
  });
});
