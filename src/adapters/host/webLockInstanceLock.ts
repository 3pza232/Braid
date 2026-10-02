import type { InstanceLock, InstanceRole } from '@ports/host/InstanceLock';

/** 锁名固定：同一 origin 下的所有标签页申请的是同一把锁 */
const LOCK_NAME = 'braid.sqlite.writer';

/**
 * 用 Web Locks 选举写者的实例协调
 *
 * Web Locks 的特点正好对得上这里的需求：它是**页面作用域、跨标签页**的、
 * 页面关闭时浏览器自动释放 —— 不需要心跳、不需要"过期时间"这类的兜底逻辑，
 * 也不会因为某个标签页崩了而永久占着锁。
 */
export function createWebLockInstanceLock(): InstanceLock {
  let decided: Promise<InstanceRole> | null = null;

  return {
    role(): Promise<InstanceRole> {
      decided ??= acquire();
      return decided;
    },
  };
}

function acquire(): Promise<InstanceRole> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') {
    // 没有 Web Locks 就没有协调手段：如实说"不支持"，不假装自己是主实例
    return Promise.resolve('unsupported');
  }

  return new Promise<InstanceRole>((resolve) => {
    const settleUnsupported = () => resolve('unsupported');

    try {
      void locks
        .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          resolve(lock === null ? 'secondary' : 'primary');
          if (lock === null) return;

          /*
           * 持有到页面关闭
           *
           * 回调返回之前锁一直归本页；返回一个永不 resolve 的 promise，
           * 就等价于"只要这个标签页活着，写者身份就在它手上"。
           * 千万不要在这里 await 外层 —— 那会让入口一直卡住。
           */
          await new Promise<void>(() => {});
        })
        .catch(settleUnsupported);
    } catch {
      /*
       * **同步**抛错（某些浏览器在不安全上下文里直接抛，而不是返回 rejected promise）
       * 也必须兜住：协调失败最多是"少一条提醒"，绝不能因此让应用起不来。
       */
      settleUnsupported();
    }
  });
}
