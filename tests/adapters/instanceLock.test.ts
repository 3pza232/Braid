import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebLockInstanceLock } from '@adapters/host/webLockInstanceLock';

/**
 * 多标签页的写者选举
 *
 * 这段逻辑会决定界面要不要弹"另一个标签页也在用"的提醒，而它只在**跑起来的
 * 浏览器里**才有真实输入（Web Locks）。所以用例把 `navigator.locks` 换掉，
 * 把三种身份都钉住 —— 尤其是"环境不支持"这一支：它必须老实说 `unsupported`，
 * 而不是默认自己就是主实例（那会让提醒永远不出现，风险反而更隐蔽）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

type RequestFn = (name: string, options: unknown, callback: (lock: unknown) => unknown) => unknown;

function stubLocks(request: RequestFn): { calls: number } {
  const counter = { calls: 0 };
  vi.stubGlobal('navigator', {
    locks: {
      request: (...args: [string, unknown, (lock: unknown) => unknown]) => {
        counter.calls += 1;
        return request(...args);
      },
    },
  });
  return counter;
}

describe('实例写者选举', () => {
  it('拿到锁 → primary', async () => {
    stubLocks(async (_name, _options, callback) => {
      void callback({ name: 'braid.sqlite.writer' });
    });

    await expect(createWebLockInstanceLock().role()).resolves.toBe('primary');
  });

  it('锁被别的标签页占着（回调拿到 null）→ secondary', async () => {
    stubLocks(async (_name, _options, callback) => {
      void callback(null);
    });

    await expect(createWebLockInstanceLock().role()).resolves.toBe('secondary');
  });

  it('宿主没有 Web Locks → unsupported（不假装自己是主实例）', async () => {
    vi.stubGlobal('navigator', {});

    await expect(createWebLockInstanceLock().role()).resolves.toBe('unsupported');
  });

  it('申请过程抛错 → unsupported（宁可不提醒，也不能因此起不来）', async () => {
    stubLocks(() => {
      throw new Error('安全上下文限制');
    });

    await expect(createWebLockInstanceLock().role()).resolves.toBe('unsupported');
  });

  it('只申请一次：锁要持到页面关闭，重复申请没有意义', async () => {
    const counter = stubLocks(async (_name, _options, callback) => {
      void callback({ name: 'braid.sqlite.writer' });
    });
    const lock = createWebLockInstanceLock();

    await lock.role();
    await lock.role();
    await lock.role();

    expect(counter.calls).toBe(1);
  });
});
