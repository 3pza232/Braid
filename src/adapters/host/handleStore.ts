/**
 * 目录句柄的持久化（IndexedDB）
 *
 * 【为什么不放在 SQLite 里】
 * `FileSystemDirectoryHandle` 是可结构化克隆对象，**只能存进 IndexedDB**，
 * 因为只有 IndexedDB 支持存储这类"宿主对象"。它是浏览器给的一把"钥匙"，
 * 序列化不成字符串，也就进不了 SQLite 的 TEXT 列。
 *
 * 【为什么不放进 localStorage】
 * localStorage 只能存字符串，且容量小。
 *
 * 于是分工是：
 *   SQLite 存 `conversation.workspace_root` —— 一个**令牌**（能进文本列）；
 *   IndexedDB 存令牌 → 句柄 —— 真正的访问能力。
 *
 * 这个分工还有一个额外好处：即使数据库被导出/复制到别的机器，
 * 里面的令牌在那边也换不到句柄（句柄是本机本浏览器独有的），**不会泄露文件访问权**。
 */

/**
 * 本文件只声明运行期真正用到的那几个成员，而不是依赖 lib.dom 里的定义
 *
 * 原因：File System Access API 在各版本 TypeScript 的 DOM 类型里时有时无，
 * 写法也变过。自己声明"我要用的最小面"，升级 TS 就不会突然编译不过；
 * 缺什么方法在编译期就能看出来，而不是运行时才发现。
 */
export interface FsDirHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  entries(): AsyncIterableIterator<[string, FsDirHandle | FsFileHandle]>;
}

export interface FsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

const DB_NAME = 'braid.fs';
const STORE_NAME = 'handles';
const DB_VERSION = 1;

interface StoredRecord {
  id: string;
  label: string;
  handle: FsDirHandle;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开句柄数据库'));
  });
}

/** 把一次读写包成一个 Promise 事务；失败一律 reject 由调用方归一化 */
async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = action(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('句柄数据库操作失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveHandle(id: string, label: string, handle: FsDirHandle): Promise<void> {
  const record: StoredRecord = { id, label, handle };
  await withStore('readwrite', (store) => store.put(record));
}

export async function loadHandle(id: string): Promise<StoredRecord | null> {
  const result = await withStore<StoredRecord | undefined>('readonly', (store) => store.get(id));
  return result ?? null;
}

export async function removeHandle(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}

/** 列出全部令牌（用于清理不再被任何会话引用的记录） */
export async function listHandleIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  return keys.map((key) => String(key));
}

/**
 * 删掉**不再被任何会话引用**的句柄记录
 *
 * 【为什么是"按引用反向扫描"，而不是"删会话时顺手删句柄"】
 * 同一个令牌可能被别处引用（复制会话、以后可能的共享目录），
 * 在删除点做判断需要知道"还有谁在用"，那个知识散落在各处、且会漏。
 * 反过来问"现在还在用哪些"只有一个答案来源（会话列表），
 * 而且"没被引用"就是这个记录该被删的**定义**，所以这样删永远安全。
 *
 * 返回删掉的条数，供调用方在开发时确认它真的在工作（0 与"没跑"是两件事）。
 */
export async function pruneHandles(keep: readonly string[]): Promise<number> {
  const alive = new Set(keep);
  let removed = 0;

  for (const id of await listHandleIds()) {
    if (alive.has(id)) continue;
    await removeHandle(id);
    removed += 1;
  }

  return removed;
}

/** 生成一个不透明令牌。用时间戳 + 随机后缀，够用且便于肉眼排查 */
export function createHandleId(): string {
  return `fsw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
