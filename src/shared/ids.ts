/**
 * 名义类型（Branded Type）
 *
 * 目的：防止把任意 string 当作 ID 传递。编译期就能发现 "把会话 ID 当消息 ID 用" 这类错误。
 * 这是零运行时开销的——`Brand` 只在类型层面存在。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type ThemeId = Brand<string, 'ThemeId'>;

/** 外部数据（数据库行、导入的 JSON）进入领域层时的统一转换点 */
export const asConversationId = (raw: string): ConversationId => raw as ConversationId;
export const asMessageId = (raw: string): MessageId => raw as MessageId;
export const asRoleId = (raw: string): RoleId => raw as RoleId;
export const asToolCallId = (raw: string): ToolCallId => raw as ToolCallId;
export const asThemeId = (raw: string): ThemeId => raw as ThemeId;
