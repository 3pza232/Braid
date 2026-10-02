/**
 * wa-sqlite 的补充类型声明
 *
 * 官方 d.ts 覆盖了 `wa-sqlite` 主入口、`dist/*.mjs` 与部分 VFS 示例，
 * 但**没有** `AccessHandlePoolVFS`（OPFS 的 VFS，正是我们要用的那个），
 * 也没有 `?url` 形式的 wasm 导入声明。这里补齐，避免用 `any` 污染业务代码。
 */

declare module 'wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
  import * as VFS from 'wa-sqlite/src/VFS.js';

  /**
   * 基于 OPFS `FileSystemSyncAccessHandle` 的 VFS。
   * 只允许在 Worker 中使用；同一目录同时只能被一个实例占用。
   */
  export class AccessHandlePoolVFS extends VFS.Base {
    /** VFS 注册时使用的名字（官方 d.ts 的 Base 没有声明它，这里补上） */
    name: string;
    /** 构造后需要 await 它，确认 OPFS 可用且句柄池就绪 */
    readonly isReady: Promise<void>;
    constructor(directoryPath: string);
  }
}

declare module 'wa-sqlite/src/examples/MemoryAsyncVFS.js' {
  import * as VFS from 'wa-sqlite/src/VFS.js';

  /** 内存 VFS：OPFS 不可用时的降级实现（数据不持久化） */
  export class MemoryAsyncVFS extends VFS.Base {
    name: string;
  }
}

declare module 'wa-sqlite/dist/wa-sqlite-async.wasm?url' {
  const url: string;
  export default url;
}
