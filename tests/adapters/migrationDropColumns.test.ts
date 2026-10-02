import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@adapters/storage/sqlite/migrations';

/**
 * 迁移 v9（删三列）在**已经有数据的旧库**上验证
 *
 * 【为什么门禁不够】`check:sql` 只在**空库**上把全部迁移跑一遍，证明的是"新装能建起来"；
 * 它证明不了"老用户的库能不能安全升上来"。而删列是**不可逆**的 ——
 * SQLite 的 `DROP COLUMN` 会重建整张表，绑错列名、丢默认值、丢掉别的列，
 * 都会在这一刻发生，而且是在用户真正的数据上。
 *
 * 所以这里自己起一个走到 v8 的库、塞进真实数据，再升到 v9，逐条检查：
 *  1. 该没的没了；
 *  2. **别的列一个都不能少**（重建表最容易伤到这里）；
 *  3. 其余数据逐字段完好；
 *  4. 升完之后还能正常写入（列清单已同步）。
 */
const sqlite = await import('node:sqlite').catch(() => null);

type Db = InstanceType<typeof import('node:sqlite').DatabaseSync>;

/**
 * 执行给定的一批迁移
 *
 * 注意是"**只跑传进来的这些**"，不是"跑到某个版本为止"：真实升级路径上
 * 每条迁移只跑一次（`runMigrations` 用 `schema_migration` 登记），
 * 而这里若每次都从头跑，v3 那句 `ADD COLUMN model_profile_id` 会在第二次调用时
 * 撞成 `duplicate column name` —— 那是夹具自己造的假故障，会盖住真正要验的东西。
 */
function apply(db: Db, migrations: readonly (typeof MIGRATIONS)[number][]): void {
  for (const migration of migrations) {
    for (const statement of migration.statements) db.exec(statement);
  }
}

const upTo = (version: number) => MIGRATIONS.filter((migration) => migration.version <= version);

function columnsOf(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe.skipIf(sqlite === null)('迁移 v10：删掉「允许编辑工作区文件」这一列', () => {
  /**
   * 老用户的库：v9 结构，有真实数据（含即将被删的列，且带着非默认值）
   *
   * 注意 `workspace_root` 也一起塞了值：它是"选中目录 = 读写权"这个新语义的载体，
   * 重建表时最不能丢的就是它。
   */
  function oldDatabase(): Db {
    const db = new sqlite!.DatabaseSync(':memory:');
    apply(db, upTo(9));
    db.exec(
      `INSERT INTO conversation (id, title, workspace_root, allow_workspace_edit, created_at, updated_at)
       VALUES ('c1', '我的小说', 'fsw-1', 1, 1000, 2000)`,
    );
    return db;
  }

  it('该没的没了，别的列与数据一个都不少', () => {
    const db = oldDatabase();

    // 前提：这一列原本存在、且真的带着值（否则下面的检查没有意义）
    expect(columnsOf(db, 'conversation')).toContain('allow_workspace_edit');
    const before = db
      .prepare('SELECT allow_workspace_edit FROM conversation')
      .get() as Record<string, unknown>;
    expect(before['allow_workspace_edit']).toBe(1);

    // 只补差量：模拟真实升级路径（v10 那一条）
    apply(
      db,
      MIGRATIONS.filter((migration) => migration.version === 10),
    );

    const columns = columnsOf(db, 'conversation');
    expect(columns).not.toContain('allow_workspace_edit');

    // ── 别的列一个都不能少（重建表最容易伤到的地方） ──
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'workspace_root',
        'role_instance_json',
        'role_id',
        'model_profile_id',
        'model',
        'params_json',
        'system_prompt',
        'keep_recent_messages',
        'writing_mode',
        'min_output_chars',
        'continuation_prompt',
        'assistant_name',
        'user_name',
        'active_root_child_id',
        'forked_from_json',
        'sort_order',
        'created_at',
        'updated_at',
        'deleted_at',
        'extensions_json',
        'schema_version',
      ]),
    );

    // ── 数据逐字段完好（尤其是工作区令牌：删掉开关之后它承担了全部语义） ──
    const row = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('c1') as Record<string, unknown>;
    expect(row['title']).toBe('我的小说');
    expect(row['workspace_root']).toBe('fsw-1');
    expect(row['created_at']).toBe(1000);
    expect(row['extensions_json']).toBe('{}'); // 默认值没在重建里丢掉

    // ── 升完之后还能正常写入（列清单已同步，插入自然不带被删的列） ──
    expect(() =>
      db.exec(
        `INSERT INTO conversation (id, title, created_at, updated_at)
         VALUES ('c2', '另一条', 3000, 3000)`,
      ),
    ).not.toThrow();

    db.close();
  });
});

describe.skipIf(sqlite === null)('迁移 v9：删掉三个只写不读的列', () => {
  /** 老用户的库：v8 结构，有真实数据（含即将被删的三列，且带着非默认值） */
  function oldDatabase(): Db {
    const db = new sqlite!.DatabaseSync(':memory:');
    apply(db, upTo(8));
    db.exec(
      `INSERT INTO conversation (id, title, created_at, updated_at, sync_state)
       VALUES ('c1', '我的小说', 1000, 2000, 'dirty')`,
    );
    db.exec(
      `INSERT INTO message
         (id, conversation_id, variant_of, role, status, segments_json,
          created_at, updated_at, continuation_index, reached_target)
       VALUES ('m1', 'c1', 'm1', 'assistant', 'complete', '[{"kind":"text","text":"第一章"}]',
              1000, 2000, 7, 0)`,
    );
    return db;
  }

  it('该没的没了，别的列与数据一个都不少', () => {
    const db = oldDatabase();

    // 前提：这些列原本是存在的，且真的带着值（否则下面的检查没有意义）
    expect(columnsOf(db, 'message')).toContain('continuation_index');
    expect(columnsOf(db, 'message')).toContain('reached_target');
    expect(columnsOf(db, 'conversation')).toContain('sync_state');
    const before = db.prepare('SELECT continuation_index, reached_target FROM message').get() as Record<
      string,
      unknown
    >;
    expect(before['continuation_index']).toBe(7);

    // 只补差量：模拟真实升级路径（v9 那一条）
    apply(
      db,
      MIGRATIONS.filter((migration) => migration.version === 9),
    );

    const messageColumns = columnsOf(db, 'message');
    expect(messageColumns).not.toContain('continuation_index');
    expect(messageColumns).not.toContain('reached_target');
    expect(columnsOf(db, 'conversation')).not.toContain('sync_state');

    // ── 别的列一个都不能少（重建表最容易伤到的地方） ──
    expect(messageColumns).toEqual(
      expect.arrayContaining([
        'id',
        'conversation_id',
        'parent_id',
        'variant_of',
        'variant_index',
        'active_child_id',
        'role',
        'segments_json',
        'status',
        'usage_json',
        'finish_reason',
        'context_flags_json',
        'created_at',
        'updated_at',
        'deleted_at',
        'extensions_json',
        'schema_version',
      ]),
    );

    // ── 数据逐字段完好 ──
    const message = db.prepare('SELECT * FROM message WHERE id = ?').get('m1') as Record<string, unknown>;
    expect(message['segments_json']).toBe('[{"kind":"text","text":"第一章"}]');
    expect(message['role']).toBe('assistant');
    expect(message['status']).toBe('complete');
    expect(message['created_at']).toBe(1000);
    expect(message['deleted_at']).toBeNull();

    const conversation = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('c1') as Record<string, unknown>;
    expect(conversation['title']).toBe('我的小说');
    expect(conversation['created_at']).toBe(1000);
    expect(conversation['extensions_json']).toBe('{}'); // 默认值没在重建里丢掉

    // ── 升完之后还能正常写入（列清单已同步，插入自然不带被删的列） ──
    expect(() =>
      db.exec(
        `INSERT INTO message (id, conversation_id, variant_of, role, status, created_at, updated_at)
         VALUES ('m2', 'c1', 'm2', 'user', 'complete', 3000, 3000)`,
      ),
    ).not.toThrow();

    db.close();
  });
});
