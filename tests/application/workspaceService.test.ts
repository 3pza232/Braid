import { describe, expect, it } from 'vitest';
import { WorkspaceService, type WorkspaceScope } from '@app/workspace/WorkspaceService';
import type { FileSystemPort, FsEntry, HandleState, WorkspaceRef } from '@ports/host/FileSystemPort';
import type { WorkspaceAlert } from '@ports/WorkspaceApi';
import { appError, err, ok } from '@shared/result';

/**
 * 工作区服务 —— **写盘门禁**与路径沙箱
 *
 * 为什么单独给它一份用例：`writeFile` 是全项目唯一"能让 AI 改动用户磁盘"的入口，
 * 它前面排了三道门（目录是否可用 / 开关是否打开 / 浏览器是否给了写权限）。
 * 这三道门任何一道写反，后果都是**不可逆的**：AI 会在未授权的目录里静默改文件。
 *
 * 用例的目标不是覆盖率，而是把这道门的**判定表**钉死：
 * 四种"不许写"的组合各是什么错、给用户看的话有没有指对地方、以及
 * "不允许时**连底层写接口都不会被调用**"（先查权限、再碰磁盘）。
 */

const REF: WorkspaceRef = { id: 'fsw-1', label: '草稿项目' };
const ENTRIES: FsEntry[] = [{ name: 'notes.txt', path: 'notes.txt', kind: 'file', size: 12 }];

interface FakeFsOptions {
  readState?: HandleState;
  writeState?: HandleState;
  /** 令牌换不回句柄（换了机器 / 目录被删） */
  describeFails?: boolean;
}

/** 假文件系统：只记录"被调用过什么"，不做任何真实 IO */
function createFakeFs(options: FakeFsOptions = {}) {
  const written: Array<{ path: string; content: string }> = [];
  const listed: string[] = [];
  const writes = { count: 0 };

  const fs = {
    supported: true,
    unsupportedReason: null,
    pickDirectory: async (pick: { mode: 'read' | 'readwrite' }) => {
      picked.push(pick.mode);
      return ok(REF);
    },
    pruneHandles: async (keep: readonly string[]) => {
      pruned.push([...keep]);
      return keep.length;
    },
    describe: async () =>
      options.describeFails === true ? err(appError('FS_NOT_FOUND', '句柄已失效')) : ok(REF),
    state: async () => options.readState ?? 'granted',
    writeState: async () => options.writeState ?? 'granted',
    requestAccess: async () => ok(options.readState ?? 'granted'),
    requestWriteAccess: async () => ok(options.writeState ?? 'granted'),
    forget: async () => undefined,
    list: async (_ref: WorkspaceRef, dir: string) => {
      listed.push(dir);
      return ok(ENTRIES);
    },
    read: async () => ok('文件内容'),
    write: async (_ref: WorkspaceRef, path: string, content: string) => {
      writes.count += 1;
      written.push({ path, content });
      return ok(undefined);
    },
  } as unknown as FileSystemPort;

  const picked: Array<'read' | 'readwrite'> = [];
  const pruned: Array<string[]> = [];
  return { fs, written, listed, writes, picked, pruned };
}

function createScope(init: { root?: string | null } = {}) {
  const state = { root: init.root === undefined ? REF.id : init.root };
  const setRootCalls: Array<string | null> = [];

  const scope: WorkspaceScope = {
    root: () => state.root,
    setRoot: async (root) => {
      setRootCalls.push(root);
      state.root = root;
    },
  };
  return { scope, state, setRootCalls };
}

/** 装配一个"已经装载完成"的服务，并收集它发出的警报 */
async function setup(
  fsOptions: FakeFsOptions = {},
  scopeInit: Parameters<typeof createScope>[0] = {},
) {
  const fake = createFakeFs(fsOptions);
  const { scope, state, setRootCalls } = createScope(scopeInit);
  const service = new WorkspaceService(fake.fs, scope);

  const alerts: WorkspaceAlert[] = [];
  service.subscribeAlerts((alert) => alerts.push(alert));

  let emits = 0;
  service.subscribe(() => {
    emits += 1;
  });

  await service.load();
  return { service, alerts, fake, state, setRootCalls, emits: () => emits };
}

const CODES = ['FS_NOT_FOUND', 'FS_PATH_DENIED', 'FS_EDIT_DENIED'] as const;

function denyCode(alerts: readonly WorkspaceAlert[]): string | null {
  const first = alerts[0];
  return first ? first.code : null;
}

describe('授权状态的刷新（顶栏那颗「需授权」必须跟着走）', () => {
  it('授权写入之后**连读取状态一起重查** —— 否则顶栏会一直亮着「需授权」', async () => {
    /*
     * 场景：重开应用后句柄还在，但浏览器把**读**权限也退回了 'prompt'。
     * 用户点「授权写入」拿到写权限 —— 读权限其实是一并给到的，所以状态必须重查。
     *
     * 早先这里只更新 `writeState` 再 commit，于是顶栏那颗「需授权」亮着不走，
     * 用户还得再去会话设置里点一次「重新授权」（而他刚刚才点过授权）——
     * 这是用户实际报上来的表现。
     */
    const fsOptions: FakeFsOptions = { readState: 'prompt', writeState: 'prompt' };
    const { service } = await setup(fsOptions);

    expect(service.snapshot().handleState).toBe('prompt');
    expect(service.snapshot().canRead).toBe(false);

    // 浏览器在这一刻把读写一起给了（假文件系统的状态是**调用时现取**的）
    fsOptions.readState = 'granted';
    fsOptions.writeState = 'granted';

    await service.authorizeWrite();

    expect(service.snapshot().writeState).toBe('granted');
    // 这一条才是"顶栏不再挂需授权"的依据
    expect(service.snapshot().handleState).toBe('granted');
    expect(service.snapshot().canRead).toBe(true);
  });
});

describe('WorkspaceService.writeFile 的门禁', () => {
  const cases: Array<{
    name: string;
    fs?: FakeFsOptions;
    scope?: Parameters<typeof createScope>[0];
    /** 期望的拒绝码；`null` 表示应当放行 */
    code: (typeof CODES)[number] | null;
    /** 拒绝时给用户看的话里必须出现的字眼（指不对地方就等于没提示） */
    says?: string;
    /** 拒绝时**不允许**碰底层写接口 */
    mustNotWrite: boolean;
  }> = [
    {
      name: '没有选择目录 → 连目录都没有',
      scope: { root: null },
      code: 'FS_NOT_FOUND',
      says: '还没有选择工作区目录',
      mustNotWrite: true,
    },
    {
      name: '目录选了但读取未授权',
      fs: { readState: 'prompt' },
      code: 'FS_PATH_DENIED',
      says: '重新授权',
      mustNotWrite: true,
    },
    {
      /*
       * 这一条替换了早先两条"编辑开关没开"的用例。
       *
       * 那个开关（全局默认 + 会话覆盖）已经删掉：**选中工作区 = 给了读写权**。
       * 所以现在"写不进去"只剩两种原因，而且都指向磁盘/浏览器那一侧：
       * 目录没了、或浏览器没放行 —— 用户要做的动作也因此只有一个（重新选择 / 授权）。
       */
      name: '浏览器没给写权限 → 指向"授权写入"',
      fs: { writeState: 'prompt' },
      code: 'FS_EDIT_DENIED',
      says: '授权写入',
      mustNotWrite: true,
    },
    {
      name: '目录已不可用 → 指向"重新选择目录"',
      fs: { writeState: 'missing' },
      code: 'FS_EDIT_DENIED',
      says: '重新选择目录',
      mustNotWrite: true,
    },
    {
      name: '三道门全过 → 放行并真的写下去',
      code: null,
      mustNotWrite: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const { service, alerts, fake } = await setup(testCase.fs, testCase.scope);

      const result = await service.writeFile('notes.txt', '新内容');

      if (testCase.code === null) {
        expect(result.ok).toBe(true);
        expect(fake.writes.count).toBe(1);
        expect(fake.written[0]).toEqual({ path: 'notes.txt', content: '新内容' });
        // 成功路径不该弹警报（否则用户会把"成功"也当成出事了）
        expect(alerts).toHaveLength(0);
        return;
      }

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(testCase.code);
      if (testCase.says !== undefined) {
        expect(alerts[0]?.message ?? '').toContain(testCase.says);
      }
      // 拒绝时也要给用户一条警报：返回错误是给模型的，警报是给人的
      expect(denyCode(alerts)).toBe(testCase.code);
      if (testCase.mustNotWrite) expect(fake.writes.count).toBe(0);
    });
  }

  it('读文件只要求"目录可用"（不列目录、不碰写权限）', async () => {
    const { service, fake } = await setup();
    const listedBefore = fake.listed.length;

    const result = await service.readFile('notes.txt');

    expect(result.ok).toBe(true);
    // 读文件不该顺手列目录（那会让模型的每次读都多打一次底层调用）
    expect(fake.listed.length).toBe(listedBefore);
  });
});

describe('WorkspaceService 的路径沙箱', () => {
  it('refresh 拒绝越界路径，且不把请求交给文件系统', async () => {
    const { service, fake } = await setup();
    const before = fake.listed.length;

    const result = await service.refresh('../secrets');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FS_PATH_DENIED');
    expect(fake.listed.length).toBe(before);
  });

  it('listFiles 拒绝越界路径', async () => {
    const { service } = await setup();
    const result = await service.listFiles('a/../../b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FS_PATH_DENIED');
  });

  it('listFiles 不会顶掉面板里的目录列表（它是模型的探查动作）', async () => {
    const { service, fake } = await setup();
    await service.refresh();
    const panelEntries = service.snapshot().entries;
    const listedBefore = fake.listed.length;

    await service.listFiles('sub');

    // 面板里那份列表还是同一个数组（`listFiles` 只读不写状态）
    expect(service.snapshot().entries).toBe(panelEntries);
    expect(fake.listed.slice(listedBefore)).toEqual(['sub']);
  });

  it('未授权时 listFiles / writeFile 都拿不到根引用', async () => {
    const { service } = await setup({}, { root: null });
    expect((await service.listFiles()).ok).toBe(false);
    expect((await service.writeFile('a.txt', 'x')).ok).toBe(false);
  });
});

describe('WorkspaceService 的装载状态', () => {
  /*
   * `canWrite` 现在只有两个输入：目录还在吗、浏览器放行写吗。
   * 早先还有第三个 —— "我们的编辑开关"（全局默认 + 会话覆盖），已随开关一起删掉。
   */
  const canWriteCases: Array<{
    name: string;
    fs?: FakeFsOptions;
    canWrite: boolean;
  }> = [
    { name: '目录 + 读 + 写 全齐', canWrite: true },
    { name: '浏览器没给写权限', fs: { writeState: 'prompt' }, canWrite: false },
    { name: '读取未授权', fs: { readState: 'denied' }, canWrite: false },
  ];

  for (const testCase of canWriteCases) {
    it(`canWrite：${testCase.name} → ${String(testCase.canWrite)}`, async () => {
      const { service } = await setup(testCase.fs);
      expect(service.snapshot().canWrite).toBe(testCase.canWrite);
    });
  }

  it('令牌换不回句柄时归为"需要重新选择"，而不是抛错', async () => {
    const { service } = await setup({ describeFails: true });

    const snapshot = service.snapshot();
    expect(snapshot.root).toBeNull();
    expect(snapshot.handleState).toBe('missing');
    expect(snapshot.canRead).toBe(false);
    // 有说明文字，界面才能告诉用户"换个浏览器/目录被删了"
    expect(snapshot.error).not.toBeNull();
  });

  it('syncScope：令牌与权限都没变时不发通知（它会被高频调用）', async () => {
    const { service, emits } = await setup();
    const before = emits();

    await service.syncScope();

    expect(emits()).toBe(before);
  });

  it('syncScope：令牌变了会重新装载（换句柄 + 重新列目录）', async () => {
    const { service, state, fake } = await setup();

    state.root = 'fsw-另外的';
    const listedBefore = fake.listed.length;
    await service.syncScope();

    // 授权到位时顺手刷新列表
    expect(fake.listed.length).toBe(listedBefore + 1);
  });

  it('selectDirectory：用户取消时什么都不改', async () => {
    const fake = createFakeFs();
    fake.fs.pickDirectory = async () => ok(null);
    const { scope, setRootCalls } = createScope();
    const service = new WorkspaceService(fake.fs, scope);

    const result = await service.selectDirectory();

    expect(result.ok).toBe(true);
    expect(setRootCalls).toEqual([]);
  });

  it('selectDirectory：**一律**要 readwrite（选中目录 = 给了读写权；事后补申请拿不到用户手势）', async () => {
    const { service, fake, setRootCalls } = await setup();

    await service.selectDirectory();
    expect(fake.picked).toEqual(['readwrite']);
    expect(setRootCalls).toEqual([REF.id]);
  });

  it('authorizeWrite：没有目录时明确报错；有目录时更新写状态', async () => {
    const noRoot = await setup({}, { root: null });
    const failed = await noRoot.service.authorizeWrite();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('FS_NOT_FOUND');

    const okCase = await setup({ writeState: 'prompt' });
    const done = await okCase.service.authorizeWrite();
    expect(done.ok).toBe(true);
    expect(okCase.service.snapshot().writeState).toBe('prompt');
  });

  it('pruneHandles 只做转发（"谁还在用"由调用方算）', async () => {
    const { service, fake } = await setup();
    const result = await service.pruneHandles(['fsw-1', 'fsw-2']);
    expect(result.ok).toBe(true);
    expect(fake.pruned).toEqual([['fsw-1', 'fsw-2']]);
  });

  it('clearDirectory 会忘记句柄并把会话里的令牌清空', async () => {
    const { service, setRootCalls } = await setup();
    await service.clearDirectory();
    expect(setRootCalls).toEqual([null]);
    expect(service.snapshot().root).toBeNull();
  });
});
