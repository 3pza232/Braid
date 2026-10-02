/**
 * 头像（值对象）
 *
 * 只有两种状态：
 *  - 有图片 → 显示图片
 *  - 没图片 → 显示名称首字；连名字都没有就只留底色，不显示任何内容
 *
 * 刻意不做 emoji 之类的第三态：能设置的东西越多，界面越花、用户越纠结。
 */
export interface AvatarRef {
  /** 图片：dataURL 或 http(s) URL；空 = 回落 */
  image: string;
  /** 底色（CSS 颜色）；空 = 跟随主题 */
  color: string;
}

/** 容错构造：丢掉老版本数据里的多余字段，缺失的补空串 */
export function makeAvatar(init?: Partial<AvatarRef> | null): AvatarRef {
  return {
    image: typeof init?.image === 'string' ? init.image : '',
    color: typeof init?.color === 'string' ? init.color : '',
  };
}

/** 取名称首字（按码点，避免 emoji / 代理对被截断） */
export function firstChar(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return [...trimmed][0] ?? '';
}

/**
 * 头像里要显示的字符
 *
 * @returns 有图片时返回空串（由 UI 渲染 <img>）；没有名字时也返回空串
 */
export function avatarGlyph(avatar: AvatarRef | undefined | null, name?: string | null): string {
  if (avatar?.image.trim()) return '';
  return name ? firstChar(name) : '';
}

export const DEFAULT_USER_AVATAR: AvatarRef = makeAvatar();
export const DEFAULT_ASSISTANT_AVATAR: AvatarRef = makeAvatar();
