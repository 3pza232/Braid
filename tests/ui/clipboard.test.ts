// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '@ui/utils/clipboard';

/**
 * 复制到剪贴板
 *
 * 契约只有一条：**如实返回成败**。调用方靠它决定要不要说话 ——
 * 早先各处直接写 `void navigator.clipboard?.writeText(...)`，把"环境不支持"和
 * "权限被拒"都吞成了"按了没反应"。
 */
const original = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
});

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('copyText', () => {
  it('环境没有剪贴板（非安全上下文）→ false，而不是静默什么都不做', async () => {
    setClipboard(undefined);
    await expect(copyText('hi')).resolves.toBe(false);
  });

  it('成功 → true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyText('内容')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('内容');
  });

  it('权限被拒（reject）→ false，而不是抛出未处理的 promise', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });

    await expect(copyText('内容')).resolves.toBe(false);
  });
});
