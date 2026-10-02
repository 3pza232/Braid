import { describe, expect, it } from 'vitest';
import { createWorkspaceToolRegistry } from '@app/tools/workspaceToolRegistry';
import type { WorkspaceApi, WorkspaceSnapshot } from '@ports/WorkspaceApi';
import type { WorkspaceRef } from '@ports/host/FileSystemPort';

/**
 * 工具注册表的"说到做到"
 *
 * 【为什么值得单独钉】
 * 这一段文案是模型判断"我能不能读写文件"的**唯一依据**（工具声明之外的全部信息
 * 都在这里）。它和实际能力一旦对不上，模型就会向用户承诺做不到的事 ——
 * 而这正是用户反馈过的问题：明明设了允许，它却说自己没权限、或者反过来
 * 没被要求就把内容写进了文件。
 *
 * 所以这里钉的是两件事：
 *  1. **`promptSection()` 与 `specs()` 必须说同一句话**（说了有工具就必须真的发出工具声明）；
 *  2. 权限措辞不能变成**行为邀请**（"已授权、无需再询问"会让模型主动落盘）。
 */

const ROOT: WorkspaceRef = { id: 'handle-1', label: 'my-novel' };

/**
 * 只实现注册表真正会用到的东西
 *
 * 断言全部落在 `snapshot()` 与 `specs()` 上，所以其余方法一律不需要 ——
 * 用一个"看着像"的假对象（而不是拉起真实的 WorkspaceService）能让这些文案规则
 * 在任何一层被改坏时立刻暴露，且不依赖文件系统。
 */
function stub(patch: Partial<WorkspaceSnapshot>): WorkspaceApi {
  const snapshot: WorkspaceSnapshot = {
    loaded: true,
    root: null,
    handleState: 'missing',
    writeState: 'missing',
    canRead: false,
    canWrite: false,
    supported: true,
    unsupportedReason: null,
    entries: [],
    error: null,
    ...patch,
  };

  return { snapshot: () => snapshot } as unknown as WorkspaceApi;
}

const grantedRead = (patch: Partial<WorkspaceSnapshot> = {}): WorkspaceApi =>
  stub({ root: ROOT, handleState: 'granted', canRead: true, ...patch });

describe('工作区工具：什么时候才把工具发出去', () => {
  it('没选目录：一个工具都不发，并让模型去请用户选目录', () => {
    const registry = createWorkspaceToolRegistry(stub({}));

    expect(registry.specs()).toHaveLength(0);
    expect(registry.promptSection()).toContain('尚未选择工作区目录');
  });

  it('选了目录但**浏览器还没放行**：同样不发工具，且措辞里不能再列出可用工具', () => {
    /*
     * 这一条是回归：早先 `promptSection()` 只看"选没选目录"，于是会出现
     * "系统提示词里列着三个工具、而这次请求根本没带 tools 字段"——
     * 模型据此宣称"我可以读你的文件"，一调用什么都没有。
     * 重开浏览器后目录授权常常需要重新确认，这条路径是真的会走到的。
     */
    const registry = createWorkspaceToolRegistry(
      stub({ root: ROOT, handleState: 'prompt', canRead: false }),
    );

    expect(registry.specs()).toHaveLength(0);
    const section = registry.promptSection();
    expect(section).toContain('没有任何文件工具可用');
    expect(section).toContain('重新授权');
    // 不能再出现"可用工具：…"那一行 —— 那正是"说了却没有"的来源
    expect(section).not.toContain('可用工具：');
  });
});

describe('工作区工具：权限措辞', () => {
  it('浏览器没给写权限：指向「授权写入」，而不是含混的"没权限"', () => {
    const registry = createWorkspaceToolRegistry(grantedRead({ writeState: 'prompt' }));

    const section = registry.promptSection();
    expect(section).toContain('授权写入');
    expect(section).toContain('浏览器只认用户的点击动作');
  });

  it('都就绪时**不能**再写"无需再次询问" —— 那句话会让模型主动落盘', () => {
    /*
     * 用户实测：让它写长内容时，它自己把正文写进了文件，理由是
     * "write_file 在场是很强的行为邀请，还标注了已授权、无需再询问"。
     * 所以这条断言盯的是**不要出现邀请语**，而不是"要出现某句话"。
     */
    const registry = createWorkspaceToolRegistry(grantedRead({ writeState: 'granted' }));

    const section = registry.promptSection();
    expect(section).not.toContain('无需再次询问');
    expect(section).not.toContain('可以直接写文件');
    // 取而代之：有权限 ≠ 该写
    expect(section).toContain('能写不等于该写');
  });
});

describe('工作区工具：使用边界写进了提示词', () => {
  it('明确要求"只在用户要求读写文件时才用"，避免它顺手把长文写进文件', () => {
    const registry = createWorkspaceToolRegistry(grantedRead());

    expect(registry.promptSection()).toContain('只在用户明确要求读写文件时使用这些工具');
  });

  it('`write_file` 的描述本身也带这条边界（模型可能只读工具声明）', () => {
    const registry = createWorkspaceToolRegistry(grantedRead());
    const write = registry.specs().find((tool) => tool.function.name === 'write_file');

    expect(write?.function.description).toContain('仅在用户明确要求');
  });
});
