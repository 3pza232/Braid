import { useSettingsStore } from '@ui/stores/settingsStore';
import { useUiStore } from '@ui/stores/uiStore';
import { useStorageStore } from '@ui/stores/storageStore';
import { SettingGroup, SettingRow } from '@ui/primitives';
import styles from './sections.module.css';

/**
 * 关于分区（从 `SettingsPanel` 逐字搬出，未改语义）
 *
 * 它不接 `settings` / `update`：只读存储状态、只触发一次「恢复默认」，
 * 传 props 进来只是一层没有意义的转手。
 */
export function AboutSection() {
  const storage = useStorageStore((s) => s.status);
  /* 「恢复默认设置」的唯一动作点；面板那边不再需要它 */
  const reset = useSettingsStore((s) => s.reset);

  return (
    <>
      <SettingGroup title="关于">
        <SettingRow label="Braid" help="本地优先的 AI 对话工作台">
          <span className={styles.aboutValue}>v{__APP_VERSION__}</span>
        </SettingRow>
        <SettingRow
          label="本地数据库"
          help="全部数据都在本机；OPFS 不可用时降级为内存库，不会保存"
        >
          <span className={styles.aboutValue}>
            {storage.error
              ? `异常：${storage.error}`
              : `${storage.engine} · schema v${storage.schemaVersion}`}
          </span>
        </SettingRow>
        <SettingRow
          label="已存数据"
          help="来自数据库的统计；刷新后数字还在，说明持久化生效"
        >
          <span className={styles.aboutValue}>
            {storage.ready
              ? `角色 ${storage.counts.roles} · 设置 ${storage.counts.settings}`
              : '尚未就绪'}
          </span>
        </SettingRow>
        {/* 只在真出问题时才出现：降级到内存库 = 现在写的东西关掉就没了 */}
        {storage.ready && !storage.durable ? (
          <SettingRow
            label="⚠️ 数据不会保存"
            help="常见原因：有另一个标签页占着同一个数据库。关掉它再刷新即可恢复"
          >
            <span className={styles.aboutValue}>当前是内存库，关掉页面内容即丢失</span>
          </SettingRow>
        ) : null}
        {storage.recreated ? (
          <SettingRow
            label="⚠️ 检测到数据库被重建"
            help="这个地址上以前的存储被清掉了。常见原因：换了端口/地址、浏览器设了「关闭时清除站点数据」、磁盘空间不足被回收、或用了无痕窗口"
          >
            <span className={styles.aboutValue}>上次的数据不在了</span>
          </SettingRow>
        ) : null}
        <SettingRow
          label="持久化存储"
          help="未授权也能正常用；要警惕的是下一行的访问地址变了"
        >
          <span className={styles.aboutValue}>
            {storage.grantedPersist ? '已授权' : '未授权 · 数据仍会保存，但磁盘紧张时可能被回收'}
          </span>
        </SettingRow>
        <SettingRow
          label="访问地址"
          help="浏览器按「协议 + 主机 + 端口」隔离存储：换个端口就是另一个站点、另一套数据。数据莫名消失时，先核对该地址与之前是否完全一致"
        >
          <span className={styles.aboutValue}>{storage.origin || '—'}</span>
        </SettingRow>
        <SettingRow label="恢复默认设置" help="只重置全局设置，不影响角色、会话与消息">
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={() => {
              /*
               * 先留一份，再重置，然后给"撤销"
               *
               * 这一下会把全局设置（含接口地址、密钥、预设词、余额脚本）一次清空。
               * 弹"确认吗"要每次多按一下，用户明确说过不喜欢；而"做错了能一步撤回"
               * 既不打断正常操作，又真的兜住了误点。
               */
              const previous = useSettingsStore.getState().settings;
              reset();
              useUiStore.getState().pushNotice({
                tone: 'alert',
                message: '已恢复默认设置（角色、会话与消息不受影响）',
                action: {
                  label: '撤销',
                  // 整份设置原样写回去：`update` 收的是"要改的字段"，给全量就等于还原
                  run: () => useSettingsStore.getState().update(previous),
                },
              });
            }}
          >
            恢复默认
          </button>
        </SettingRow>
        <SettingRow label="作者">
          <span className={styles.aboutValue}>PZA</span>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
