import { describe, expect, it } from 'vitest';
import { findUnknownMacros, resolveMacros } from '@domain/rules/macroResolver';

/**
 * 提示词宏替换
 *
 * 它同时承担两个容易互相冲突的目标：
 *  1. 替换结果必须**逐字节稳定**（前缀缓存要求开头完全一致）；
 *  2. 写错的变量必须**看得出来**（原样保留，而不是替换成空）。
 */
describe('resolveMacros', () => {
  const vars = { user: '老王', char: '小助' };

  it('替换已知变量', () => {
    expect(resolveMacros('你好，{{char}}！我是{{user}}', vars)).toBe('你好，小助！我是老王');
  });

  it('允许变量名两侧有空格（用户手写时的常见形态）', () => {
    expect(resolveMacros('{{ char }}', vars)).toBe('小助');
  });

  it('未知变量原样保留：写错要看得见，替换成空会被当成"模型变笨了"', () => {
    expect(resolveMacros('{{chra}}', vars)).toBe('{{chra}}');
  });

  it('没有宏时不改变原字符串（连一次扫描都不做）', () => {
    const text = '一段没有任何花括号的普通提示词';
    expect(resolveMacros(text, vars)).toBe(text);
  });

  it('空串安全返回', () => {
    expect(resolveMacros('', vars)).toBe('');
  });

  it('变量值里的花括号不会被二次解析（不做递归替换）', () => {
    // 否则 {{a}} 的值里含 {{b}} 时会连带展开，结果不可预测
    expect(resolveMacros('{{a}}', { a: '{{b}}', b: '不该出现' })).toBe('{{b}}');
  });

  it('替换是纯函数：同样输入永远同样输出（缓存命中的前提）', () => {
    const text = '{{user}} / {{char}}';
    expect(resolveMacros(text, vars)).toBe(resolveMacros(text, vars));
  });

  it('变量名允许字母数字与 . - _', () => {
    expect(resolveMacros('{{a.b-c_1}}', { 'a.b-c_1': 'ok' })).toBe('ok');
  });

  it('空字符串的值会被当成"已定义"，替换成空（这与"未知"是两件事）', () => {
    expect(resolveMacros('[{{x}}]', { x: '' })).toBe('[]');
  });
});

describe('findUnknownMacros', () => {
  const vars = { user: '老王' };

  it('列出所有未定义的变量名（用于角色编辑器的实时校验）', () => {
    expect(findUnknownMacros('{{user}} {{chra}} {{naem}}', vars)).toEqual(['chra', 'naem']);
  });

  it('同一个变量写多次只报一次', () => {
    expect(findUnknownMacros('{{x}} {{x}} {{x}}', vars)).toEqual(['x']);
  });

  it('全部已知时返回空数组', () => {
    expect(findUnknownMacros('{{user}}', vars)).toEqual([]);
  });

  it('没有宏时返回空数组', () => {
    expect(findUnknownMacros('普通文本', vars)).toEqual([]);
  });

  it('定义成空串的变量算已知，不报缺失', () => {
    expect(findUnknownMacros('{{x}}', { x: '' })).toEqual([]);
  });
});
