import { describe, expect, it } from 'vitest';
import {
  joinWorkspacePath,
  normalizeWorkspaceDir,
  normalizeWorkspacePath,
} from '@domain/rules/workspacePath';
import { resolveWorkspacePermission } from '@domain/value-objects/workspace';

const REASONS = ['empty', 'absolute', 'drive', 'escape', 'nul', 'too_deep'] as const;

describe('工作区路径沙箱', () => {
  it('等价写法收敛成同一个字符串', () => {
    expect(normalizeWorkspacePath('a/b.txt')).toMatchObject({ ok: true, path: 'a/b.txt' });
    expect(normalizeWorkspacePath('a\\b.txt')).toMatchObject({ ok: true, path: 'a/b.txt' });
    expect(normalizeWorkspacePath('./a/b')).toMatchObject({ ok: true, path: 'a/b' });
    expect(normalizeWorkspacePath('a//b')).toMatchObject({ ok: true, path: 'a/b' });
    expect(normalizeWorkspacePath('a/./b')).toMatchObject({ ok: true, path: 'a/b' });
    expect(normalizeWorkspacePath('a/b/')).toMatchObject({ ok: true, path: 'a/b' });
    expect(normalizeWorkspacePath('我的小说/第一章.txt')).toMatchObject({
      ok: true,
      path: '我的小说/第一章.txt',
    });
  });

  it('看起来像转义、其实不是的写法必须放行', () => {
    // 只有整段等于 .. 才是上级目录
    expect(normalizeWorkspacePath('a/.../b')).toMatchObject({ ok: true, path: 'a/.../b' });
    expect(normalizeWorkspacePath('a/..hidden/b')).toMatchObject({ ok: true, path: 'a/..hidden/b' });
    expect(normalizeWorkspacePath('a/b..c')).toMatchObject({ ok: true, path: 'a/b..c' });
  });

  it.each([
    ['../secret', 'escape'],
    ['a/../../secret', 'escape'],
    ['..\\secret', 'escape'],
    ['a/b/../../../etc/passwd', 'escape'],
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share\\x', 'absolute'],
    ['C:/Windows/system32/config', 'drive'],
    ['c:\\Windows', 'drive'],
    ['', 'empty'],
    ['.', 'empty'],
    ['./', 'empty'],
    ['a/\0b', 'nul'],
  ])('%s → 拒绝（%s）', (input, reason) => {
    const verdict = normalizeWorkspacePath(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe(reason);
    expect(REASONS).toContain(reason);
  });

  it('过深的路径拒绝', () => {
    const deep = Array.from({ length: 60 }, (_, index) => `d${index}`).join('/');
    expect(normalizeWorkspacePath(deep)).toMatchObject({ ok: false, reason: 'too_deep' });
  });

  it('目录归一化允许空（工作区根目录本身是合法目标）', () => {
    expect(normalizeWorkspaceDir('')).toMatchObject({ ok: true, path: '' });
    expect(normalizeWorkspaceDir('a/./b')).toMatchObject({ ok: true, path: 'a/b' });
  });

  it('拼接不会产生多余斜杠', () => {
    expect(joinWorkspacePath('', 'a.txt')).toBe('a.txt');
    expect(joinWorkspacePath('sub', 'a.txt')).toBe('sub/a.txt');
  });
});

describe('工作区编辑权限解析（会话覆盖 > 全局默认）', () => {
  it.each([
    [{ allowEdit: false }, null, false, 'global'],
    [{ allowEdit: true }, null, true, 'global'],
    [{ allowEdit: true }, false, false, 'conversation'],
    [{ allowEdit: false }, true, true, 'conversation'],
  ] as const)('全局 %j + 覆盖 %j → allowEdit=%s (%s)', (global, override, allowEdit, source) => {
    expect(resolveWorkspacePermission({ global, override })).toEqual({ allowEdit, source });
  });
});
