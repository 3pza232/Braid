import clsx from 'clsx';
import type { AvatarRef } from '@domain/value-objects/avatar';
import { avatarGlyph } from '@domain/value-objects/avatar';
import styles from './Avatar.module.css';

/**
 * 头像
 *
 * 显示规则的**唯一实现**：图片 > emoji > 名称首字 > 空（只留底色）。
 * 消息、侧栏、角色列表、设置预览全部复用它，因此四处永远一致。
 */
export function Avatar({
  avatar,
  name,
  size = 34,
  className,
  tone = 'default',
}: {
  avatar: AvatarRef | undefined | null;
  name?: string | null;
  size?: number;
  className?: string;
  /** user = 用强调色底；default = 用中性底 */
  tone?: 'default' | 'user' | 'system';
}) {
  const image = avatar?.image?.trim() ?? '';
  const glyph = avatarGlyph(avatar, name);

  return (
    <span
      className={clsx(styles.avatar, className)}
      data-tone={tone}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        ...(avatar?.color ? { background: avatar.color, color: '#fff', borderColor: 'transparent' } : {}),
      }}
      aria-hidden="true"
    >
      {image ? (
        <img className={styles.image} src={image} alt="" draggable={false} />
      ) : (
        glyph || null
      )}
    </span>
  );
}
