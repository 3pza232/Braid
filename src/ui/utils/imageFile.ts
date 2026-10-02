/**
 * 把用户选择的图片文件压成小尺寸 dataURL
 *
 * 为什么必须压缩：头像会被存进 localStorage（S2 后进 SQLite），
 * 原图动辄几 MB，直接存会撑爆存储配额。压到 160px 见方后通常只有几 KB。
 */
const MAX_EDGE = 160;

export async function fileToAvatarDataUrl(file: File): Promise<string> {
  // createImageBitmap 在 Chromium 系（WebView2 / Edge / Chrome）都支持
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建画布上下文');

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // WebP 体积更小；不支持时浏览器会自动回退为 PNG
  return canvas.toDataURL('image/webp', 0.9);
}

/**
 * 选图的结果
 *
 * 【为什么"取消"与"读不出来"必须分开】
 * 两者早先都返回 `null`，于是界面上完全一样：**什么都没发生**。
 * 但它们是两件事 —— 取消是用户自己的选择（该安静），失败是意外（该说话）：
 * 选了张 HEIC 或坏文件时，用户看到的是"选了图却毫无变化"，只会以为按钮坏了。
 */
export type AvatarPickResult =
  | { kind: 'picked'; dataUrl: string }
  /** 用户关掉了选择框 */
  | { kind: 'cancelled' }
  /** 选中的文件读不出来（不是图片 / 格式不支持 / 解码失败） */
  | { kind: 'failed'; reason: string };

/** 打开系统文件选择器，返回压缩后的 dataURL */
export function pickAvatarImage(): Promise<AvatarPickResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';

    let settled = false;
    const finish = (result: AvatarPickResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(result);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish({ kind: 'cancelled' });
        return;
      }
      fileToAvatarDataUrl(file)
        .then((dataUrl) => finish({ kind: 'picked', dataUrl }))
        .catch((error: unknown) =>
          finish({
            kind: 'failed',
            reason: error instanceof Error ? error.message : '这张图片读不出来',
          }),
        );
    });

    /*
     * 取消选择框不一定派发 change（`cancel` 事件较新的浏览器才有）
     *
     * 没有这一步的后果是**功能看起来坏了**：调用方等不到 resolve，
     * 按钮会永远停在"处理中…"并保持禁用。窗口重新拿到焦点后还没结果，就按取消处理。
     */
    input.addEventListener('cancel', () => finish({ kind: 'cancelled' }));
    const onFocus = () => {
      window.setTimeout(() => finish({ kind: 'cancelled' }), 300);
    };
    window.addEventListener('focus', onFocus, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}
