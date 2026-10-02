import type { RolePreset } from '@domain/entities/rolePreset';
import type { RoleId } from '@shared/ids';
import type { Result } from '@shared/result';

/**
 * 角色持久化端口
 *
 * 现在是 `SqliteRoleStore`（`role_preset` 表，一个角色一行）。
 * 端口与实现分开的意义仍在这里：换存储（换表、换后端）时 `RoleService`
 * 与全部 UI 代码零改动。
 */
export interface RoleStore {
  getAll(): Promise<Result<RolePreset[]>>;
  save(role: RolePreset): Promise<Result<void>>;
  /**
   * 批量保存（**一个事务**）
   *
   * 与 `ConversationStore.saveMany` 同因：拖动排序一次改多行，
   * 逐条写中途失败会留下"半个新顺序"。
   */
  saveMany(roles: readonly RolePreset[]): Promise<Result<void>>;
  remove(id: RoleId): Promise<Result<void>>;

  /**
   * 出厂样例是否已经初始化过
   *
   * 为什么要把它放在端口上，而不是让 `RoleService` 去读 `localStorage` 判断：
   *  - 应用层**不应该知道数据存在哪**（那是适配器的知识）；
   *  - 判定"是否首次运行"的正确依据是"该存储有没有被初始化过"，
   *    而这件事只有存储自己最清楚（localStorage 看 key，SQLite 看记录）。
   *
   * 用途：用户把出厂样例全部删掉后，重启**不会**再被塞回来（尊重用户选择）。
   */
  hasSeeded(): Promise<Result<boolean>>;
  /** 记下"已初始化"，与 hasSeeded 配对使用 */
  markSeeded(): Promise<Result<void>>;
}
