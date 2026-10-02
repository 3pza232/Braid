import { useState } from 'react';
import { useUiStore } from '@ui/stores/uiStore';
import type { AvatarRef } from '@domain/value-objects/avatar';
import { makeAvatar } from '@domain/value-objects/avatar';
import { Tooltip } from '@ui/primitives';
import { pickAvatarImage } from '@ui/utils/imageFile';
import { Avatar } from './Avatar';
import styles from './AvatarEditor.module.css';

/**
 * 头像编辑器（全局身份与角色预设共用）
 *
 * 只有两件事：上传图片、选底色。
 * 没有图片时自动显示名称首字，连名字都没有就只留底色 —— 不需要用户额外配置。
 */
export function AvatarEditor({
  value,
  onChange,
  name,
  colorFallback = '#6366F1',
}: {
  value: AvatarRef;
  onChange: (next: AvatarRef) => void;
  /** 回落用的名字（角色名 / AI 名），仅用于预览 */
  name?: string | null;
  colorFallback?: string;
}) {
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    setBusy(true);
    try {
      const picked = await pickAvatarImage();
      // 取消是用户自己的决定：安静地结束，什么都不说
      if (picked.kind === 'cancelled') return;
      if (picked.kind === 'failed') {
        // 读不出来必须说话：否则"选了张图却毫无变化"，用户只会以为按钮坏了
        useUiStore
          .getState()
          .pushNotice({ tone: 'error', message: `图片读不出来：${picked.reason}` });
        return;
      }
      onChange({ ...value, image: picked.dataUrl });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.editor}>
      <Avatar avatar={value} name={name} size={36} />

      <button type="button" className={styles.btn} onClick={upload} disabled={busy}>
        {busy ? '处理中…' : value.image ? '更换图片' : '上传图片'}
      </button>

      {value.image ? (
        <button
          type="button"
          className={styles.btn}
          onClick={() => onChange(makeAvatar({ ...value, image: '' }))}
        >
          移除图片
        </button>
      ) : (
        <span className={styles.hint}>未设置时显示名称首字</span>
      )}

      <Tooltip label="头像底色">
        <input
          type="color"
          className={styles.colorInput}
          value={value.color || colorFallback}
          onChange={(e) => onChange({ ...value, color: e.target.value })}
          aria-label="头像底色"
        />
      </Tooltip>

      <Tooltip label="清除自定义底色，跟随主题">
        <button
          type="button"
          className={styles.btn}
          onClick={() => onChange(makeAvatar({ ...value, color: '' }))}
        >
          默认色
        </button>
      </Tooltip>
    </div>
  );
}
