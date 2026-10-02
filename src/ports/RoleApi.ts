import type { RolePreset } from '@domain/entities/rolePreset';
import type { RoleId } from '@shared/ids';
import type { Result } from '@shared/result';

/**
 * 角色服务的对外契约（窄接口）
 *
 * 定位：Braid 只提供**编辑器与解析规则**，不预设任何角色倾向。
 * 出厂样例角色也是可编辑、可删除的普通数据。
 */
export interface RoleApi {
  list(): RolePreset[];
  get(id: RoleId | null | undefined): RolePreset | null;
  isLoaded(): boolean;
  load(): Promise<Result<RolePreset[]>>;

  /** 新建一个空白角色（已落库） */
  create(init?: Partial<RolePreset>): Promise<Result<RolePreset>>;
  /** 保存（不存在则插入） */
  upsert(role: RolePreset): Promise<Result<RolePreset>>;
  /** 复制一份，名字加「副本」 */
  duplicate(id: RoleId): Promise<Result<RolePreset | null>>;
  remove(id: RoleId): Promise<Result<void>>;
  /**
   * 手动排序
   *
   * 传的是**当前可见顺序**的 id 列表：没在列表里的角色保持原编号不动
   * （给看不见的东西重编号，等于每次拖动都在悄悄改动用户没看到的东西）。
   */
  reorder(orderedIds: RoleId[]): Promise<Result<void>>;

  /** 从 JSON 导入（容错优先，未知字段进 extensions） */
  importFromJson(json: string): Promise<Result<RolePreset | null>>;
  /** 导出为 JSON 文本 */
  exportToJson(id: RoleId): Result<string>;

  subscribe(listener: (roles: RolePreset[]) => void): () => void;
}
