import type { FileDialogPort } from '@ports/host/FileDialogPort';
import { appError, err, ok, type Result } from '@shared/result';

/**
 * 基于 File System Access 的文件对话框
 *
 * 两条路径都要有：
 *  - 支持 `showSaveFilePicker` 时走**真正的另存为**（用户可以选目录、覆盖已有文件）；
 *  - 不支持时退化成浏览器下载 / `<input type="file">`。
 * 后者体验差一截，但"能用"与"完全没有"之间差着一次数据丢失。
 */

interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}

interface PickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileHandleLike>;
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileHandleLike[]>;
}

const pickers = globalThis as unknown as PickerWindow;

/** 用户在系统对话框里点了取消 —— 各家浏览器抛的都不是同一个东西，只能宽泛判断 */
function isCancelled(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'NotAllowedError');
}

function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // 立刻回收：blob 不释放会一直占着内存，导出大文件时很可观
  URL.revokeObjectURL(url);
}

/** 退化路径：用临时 <input type="file"> 让用户挑文件 */
function pickByInput(extensions: string[]): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // 用户取消时 change 不会触发；窗口重新聚焦后兜一下，避免 promise 永远悬着
    window.addEventListener(
      'focus',
      () => window.setTimeout(() => finish(input.files?.[0] ?? null), 300),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export function createFsaFileDialog(): FileDialogPort {
  return {
    isSupported: () => typeof pickers.showSaveFilePicker === 'function',

    async saveText(suggestedName: string, text: string): Promise<Result<boolean>> {
      if (!pickers.showSaveFilePicker) {
        downloadText(suggestedName, text);
        return ok(true);
      }
      try {
        const handle = await pickers.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return ok(true);
      } catch (error) {
        if (isCancelled(error)) return ok(false);
        return err(appError('FS_IO_ERROR', error instanceof Error ? error.message : '保存失败'));
      }
    },

    async openText(description: string, extensions: string[]): Promise<Result<string | null>> {
      try {
        if (!pickers.showOpenFilePicker) {
          const file = await pickByInput(extensions);
          return ok(file ? await file.text() : null);
        }
        const [handle] = await pickers.showOpenFilePicker({
          multiple: false,
          types: [{ description, accept: { 'application/json': extensions } }],
        });
        if (!handle) return ok(null);
        return ok(await (await handle.getFile()).text());
      } catch (error) {
        if (isCancelled(error)) return ok(null);
        return err(appError('FS_IO_ERROR', error instanceof Error ? error.message : '读取失败'));
      }
    },
  };
}
