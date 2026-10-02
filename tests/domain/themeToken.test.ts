import { describe, expect, it } from 'vitest';
import { themeTokenName } from '@domain/value-objects/themeToken';

/**
 * token 路径 → CSS 变量名
 *
 * 这条规则有**两个调用方**（主题编译器、界面的逐项自定义颜色），两者必须得出同一个名字：
 * 一旦漂移，用户改的颜色会写到一个没人用的变量上 —— 界面毫无变化、也没有报错。
 * 所以它值得有自己的用例，而不是靠两个调用点各自"看起来对"。
 */
describe('themeTokenName', () => {
  it('点分路径换成短横线（界面覆盖用的就是这种形状）', () => {
    expect(themeTokenName('role.userBubble')).toBe('role-user-bubble');
    expect(themeTokenName('bg.canvas')).toBe('bg-canvas');
  });

  it('camelCase 拆成短横线（主题 JSON 里的键是这种形状）', () => {
    expect(themeTokenName('userBubble')).toBe('user-bubble');
    expect(themeTokenName('accentDefault')).toBe('accent-default');
  });

  it('已经是短横线/纯小写的原样保留', () => {
    expect(themeTokenName('tooltip')).toBe('tooltip');
    expect(themeTokenName('bg-sunken')).toBe('bg-sunken');
  });

  it('数字后面的大写也要拆（gray600 之类不能粘在一起）', () => {
    expect(themeTokenName('gray600Strong')).toBe('gray600-strong');
  });

  it('连字符开头的键不会产生双横线（--color-… 的拼接要干净）', () => {
    expect(themeTokenName('onAccent')).toBe('on-accent');
  });
});
