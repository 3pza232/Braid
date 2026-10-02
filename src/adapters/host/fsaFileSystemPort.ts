import { appError, err, ok, toAppError, type AppError, type Result } from '@shared/result';
import { joinWorkspacePath, normalizeWorkspaceDir, normalizeWorkspacePath } from '@domain/rules/workspacePath';
import type {
  FileSystemPort,
  FsEntry,
  HandleState,
  WorkspaceRef,
} from '@ports/host/FileSystemPort';
import {
  createHandleId,
  loadHandle,
  pruneHandles as pruneStoredHandles,
  removeHandle,
  saveHandle,
  type FsDirHandle,
  type FsFileHandle,
} from './handleStore';

/**
 * File System Access API 实现（Web 宿主）
 *
 * 只做三件事：**弹选择器拿句柄 → 存起来 → 用句柄列目录/读写**。
 * 所有"能不能做"的判断都在这一层完成并归一化成 `Result`，
 * 上层（WorkspaceService）只处理业务规则（权限开关、越界、审计），不碰浏览器 API。
 *
 * 【已知限制，必须如实告知用户】
 * 浏览器不给真实路径，所以 `label` 只是目录名。用户在界面上看到的是
 * "my-novel" 而不是 "D:\\projects\\my-novel" —— 这是浏览器的安全模型决定的，
 * 不是我们没做。桌面壳（Electron）本可以经 IPC 拿到完整路径，但那样渲染进程
 * 就要有 Node 能力 —— 那是**刻意不换**的（见 `electron/main.cjs` 的取舍）。
 */

type PickerWindow = {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FsDirHandle>;
};

function pickerOf(): PickerWindow['showDirectoryPicker'] | null {
  const candidate = (globalThis as PickerWindow).showDirectoryPicker;
  return typeof candidate === 'function' ? candidate : null;
}

/** 判断是否是"用户点了取消" —— 这是正常操作，不是错误 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function permissionMode(mode: 'read' | 'readwrite'): { mode: 'read' | 'readwrite' } {
  return { mode };
}

/**
 * 把浏览器的 DOMException 归一化成**准确的**错误
 *
 * 不这么做会出大问题（真实踩过）：`getDirectoryHandle(name, { create: true })`
 * 在**权限不足**时抛的是 `NotAllowedError`。如果统一套一句"目录不存在"，
 * 用户和模型都会被引到"去查目录结构"这条错误的路上去 ——
 * 而真正该做的是"点一次授权写入"。**错误信息指向哪里，人就会去哪里找**。
 */
function fsError(error: unknown, fallback: string, path?: string): AppError {
  const name = error instanceof DOMException ? error.name : '';
  const detail = name.length > 0 ? { detail: name } : undefined;

  switch (name) {
    case 'NotFoundError':
      return appError('FS_NOT_FOUND', path ? `工作区里没有：${path}` : fallback, detail);
    case 'NotAllowedError':
    case 'SecurityError':
      return appError(
        'FS_EDIT_DENIED',
        '浏览器拒绝了这次目录操作：该目录可能只被授权了「读取」。请在设置里点一次「授权写入」再试',
        detail,
      );
    case 'TypeMismatchError':
      return appError('FS_PATH_DENIED', `${path ?? '该路径'} 不是目录（可能是一个同名文件）`, detail);
    default:
      return toAppError(error, fallback);
  }
}

async function resolveHandle(ref: WorkspaceRef): Promise<Result<FsDirHandle>> {
  let record;
  try {
    record = await loadHandle(ref.id);
  } catch (error) {
    return err(toAppError(error, '无法读取已保存的工作区目录'));
  }
  if (!record) {
    return err(appError('FS_NOT_FOUND', '工作区目录的授权已丢失，请重新选择目录'));
  }
  return ok(record.handle);
}

/**
 * 逐级下钻到目标目录
 *
 * `create` 为真时缺失的层级会被创建 —— 这是"AI 新建一个子目录再放文件"所需的；
 * 为假时缺失即 `FS_NOT_FOUND`，不会静默创建。
 */
/** 查一个句柄在指定模式下的权限状态 */
async function queryState(handle: FsDirHandle, mode: 'read' | 'readwrite'): Promise<HandleState> {
  if (!handle.queryPermission) return 'granted';
  try {
    const permission = await handle.queryPermission(permissionMode(mode));
    if (permission === 'granted') return 'granted';
    return permission === 'denied' ? 'denied' : 'prompt';
  } catch {
    // 查权限本身都失败，说明句柄已经不可用了（目录被删 / 被移动 / 被替换）
    return 'missing';
  }
}

/**
 * 申请某个模式的权限
 *
 * ⚠️ 调用方**必须在用户手势里**调用，否则浏览器会直接给 `denied`。
 */
async function requestPermissionFor(
  ref: WorkspaceRef,
  mode: 'read' | 'readwrite',
  fallbackMessage: string,
): Promise<Result<HandleState>> {
  const result = await resolveHandle(ref);
  if (!result.ok) return result;

  const handle = result.data;
  if (!handle.requestPermission) return ok('granted');
  try {
    const permission = await handle.requestPermission(permissionMode(mode));
    return ok(permission === 'granted' ? 'granted' : 'denied');
  } catch (error) {
    if (isAbort(error)) return ok('denied');
    return err(fsError(error, fallbackMessage));
  }
}

async function resolveDir(
  root: FsDirHandle,
  dir: string,
  create: boolean,
): Promise<Result<FsDirHandle>> {
  const verdict = normalizeWorkspaceDir(dir);
  if (!verdict.ok) return err(appError('FS_PATH_DENIED', verdict.message));

  let current = root;
  for (const segment of verdict.path === '' ? [] : verdict.path.split('/')) {
    try {
      current = await current.getDirectoryHandle(segment, { create });
    } catch (error) {
      // 用 fsError 而不是笼统的兜底：权限不足时这里抛的是 NotAllowedError，
      // 若一律说成"目录不存在"，用户会去翻目录结构，而真正该做的是点一次授权
      return err(fsError(error, `无法打开目录：${segment}`, segment));
    }
  }
  return ok(current);
}

export function createFsaFileSystemPort(): FileSystemPort {
  const supported = pickerOf() !== null;

  return {
    supported,
    unsupportedReason: supported
      ? null
      : '当前浏览器不支持选择本地目录（需要 Chromium 内核的 Chrome 或 Edge）。工作区功能已关闭',

    async pickDirectory(options): Promise<Result<WorkspaceRef | null>> {
      const pick = pickerOf();
      if (!pick) {
        return err(appError('FS_IO_ERROR', '当前浏览器不支持选择本地目录'));
      }
      try {
        /*
         * 权限**一次要够**
         *
         * 用户已经允许编辑时才要 `readwrite`：这是**唯一**能拿到写入权限的时机，
         * 因为它同时是"用户手势"和"授权弹窗出现的地方"。
         * 没允许编辑就只要 `read` —— 默认最小权限，不拿用不到的授权。
         */
        const handle = await pick({ mode: options.mode });
        const id = createHandleId();
        await saveHandle(id, handle.name, handle);
        return ok({ id, label: handle.name });
      } catch (error) {
        if (isAbort(error)) return ok(null);
        return err(fsError(error, '选择目录失败'));
      }
    },

    async describe(id: string): Promise<Result<WorkspaceRef>> {
      try {
        const record = await loadHandle(id);
        if (!record) {
          return err(appError('FS_NOT_FOUND', '工作区目录的授权已丢失，请重新选择目录'));
        }
        return ok({ id: record.id, label: record.label });
      } catch (error) {
        return err(toAppError(error, '无法读取已保存的工作区目录'));
      }
    },

    async state(ref: WorkspaceRef): Promise<HandleState> {
      if (!supported) return 'unsupported';
      const result = await resolveHandle(ref);
      if (!result.ok) return 'missing';
      return queryState(result.data, 'read');
    },

    async writeState(ref: WorkspaceRef): Promise<HandleState> {
      if (!supported) return 'unsupported';
      const result = await resolveHandle(ref);
      if (!result.ok) return 'missing';
      return queryState(result.data, 'readwrite');
    },

    async requestAccess(ref: WorkspaceRef): Promise<Result<HandleState>> {
      return requestPermissionFor(ref, 'read', '重新授权失败');
    },

    async requestWriteAccess(ref: WorkspaceRef): Promise<Result<HandleState>> {
      return requestPermissionFor(ref, 'readwrite', '申请目录写入权限失败');
    },

    async forget(ref: WorkspaceRef): Promise<void> {
      try {
        await removeHandle(ref.id);
      } catch {
        // 清不掉就算了：这只是一次清理，不该让"清空工作区"这个动作失败
      }
    },

    async pruneHandles(keep: readonly string[]): Promise<number> {
      try {
        return await pruneStoredHandles(keep);
      } catch {
        /*
         * 清理失败不该影响启动：孤儿记录只是占地方，不影响任何功能。
         * 返回 0 而不是抛错 —— 调用方只想知道"删了几条"。
         */
        return 0;
      }
    },

    async list(ref: WorkspaceRef, dir: string): Promise<Result<FsEntry[]>> {
      const handleResult = await resolveHandle(ref);
      if (!handleResult.ok) return handleResult;

      // 列表是用户主动触发的动作，这里顺手把"已授权过"的句柄再次确认一次
      const permission = await this.state(ref);
      if (permission !== 'granted') {
        return err(appError('FS_PATH_DENIED', '工作区目录需要重新授权'));
      }

      const dirResult = await resolveDir(handleResult.data, dir, false);
      if (!dirResult.ok) return dirResult;

      const base = normalizeWorkspaceDir(dir);
      const basePath = base.ok ? base.path : '';

      try {
        const entries: FsEntry[] = [];
        for await (const [name, child] of dirResult.data.entries()) {
          entries.push({
            name,
            path: joinWorkspacePath(basePath, name),
            kind: child.kind === 'directory' ? 'directory' : 'file',
            size: child.kind === 'file' ? await sizeOf(child) : null,
          });
        }
        // 目录在前、同类按名称排序：稳定的顺序让"刷新"不会看起来像"内容变了"
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-CN');
        });
        return ok(entries);
      } catch (error) {
        return err(toAppError(error, '读取目录失败'));
      }
    },

    async read(ref: WorkspaceRef, path: string): Promise<Result<string>> {
      const handleResult = await resolveHandle(ref);
      if (!handleResult.ok) return handleResult;

      const verdict = normalizeWorkspacePath(path);
      if (!verdict.ok) return err(appError('FS_PATH_DENIED', verdict.message));

      const segments = verdict.path.split('/');
      const fileName = segments.pop() as string;
      const dirResult = await resolveDir(handleResult.data, segments.join('/'), false);
      if (!dirResult.ok) return dirResult;

      try {
        const fileHandle = await dirResult.data.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return ok(await file.text());
      } catch (error) {
        return err(fsError(error, `无法读取文件：${verdict.path}`, verdict.path));
      }
    },

    async write(ref: WorkspaceRef, path: string, content: string): Promise<Result<void>> {
      const handleResult = await resolveHandle(ref);
      if (!handleResult.ok) return handleResult;

      const verdict = normalizeWorkspacePath(path);
      if (!verdict.ok) return err(appError('FS_PATH_DENIED', verdict.message));

      /*
       * 这里**只检查、不申请**
       *
       * 浏览器只在用户手势里授予写入权限，而工具执行发生在流式生成中途 ——
       * 那里没有手势，调 `requestPermission` 只会被拒，而且报错会把原因
       * 引向错误的方向（真实踩过：显示出"申请目录写入权限失败"，
       * 用户以为是开关坏了，其实是申请的时机不对）。
       * 写入权限必须在用户点开关 / 点授权按钮时就拿到。
       */
      const permission = await queryState(handleResult.data, 'readwrite');
      if (permission !== 'granted') {
        return err(
          appError(
            'FS_EDIT_DENIED',
            permission === 'missing'
              ? '工作区目录已不可用（可能被移动或删除），请重新选择目录'
              : '浏览器还没有授予这个目录的「写入」权限。请在设置里点一次「授权写入」—— 浏览器只在你的点击动作里给权限，模型自己申请不了',
          ),
        );
      }

      const segments = verdict.path.split('/');
      const fileName = segments.pop() as string;
      // 写文件时允许创建缺失的中间目录：AI 常见操作是"新建目录再放文件"
      const dirResult = await resolveDir(handleResult.data, segments.join('/'), true);
      if (!dirResult.ok) return dirResult;

      try {
        const fileHandle = await dirResult.data.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return ok(undefined);
      } catch (error) {
        return err(fsError(error, `无法写入文件：${verdict.path}`, verdict.path));
      }
    },
  };
}

/** 文件大小只用于展示，读不到就给 null，不要因为它让整个列表失败 */
async function sizeOf(handle: FsFileHandle): Promise<number | null> {
  try {
    const file = await handle.getFile();
    return file.size;
  } catch {
    return null;
  }
}
