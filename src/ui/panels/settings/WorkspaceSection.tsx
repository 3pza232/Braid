import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { SettingGroup, SettingRow, Switch } from '@ui/primitives';
import { useWorkspaceStore } from '@ui/stores/workspaceStore';
import styles from './sections.module.css';

interface WorkspaceSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/** 工作区分区（从 `SettingsPanel` 逐字搬出，未改语义） */
export function WorkspaceSection({ settings, update }: WorkspaceSectionProps) {
  const workspace = useWorkspaceStore((s) => s.snapshot);
  const authorizeWrite = useWorkspaceStore((s) => s.authorizeWrite);

  return (
    <>
      <SettingGroup
        title="工作区"
        help="工作区是「本会话可以访问的本地目录」，在会话设置或顶栏里选择。AI 的文件工具只能访问该目录内的内容，越界一律拒绝"
      >
        <SettingRow
          label="允许 AI 编辑工作区文件"
          help="关闭时 AI 只能读：它一旦尝试写文件，会收到「无权限编辑文件」并向你弹出警报，而不是悄悄失败。开启后无需逐次询问即可写入"
          hint="全局默认 · 每个会话可单独覆盖"
        >
          <Switch
            label="允许 AI 编辑工作区文件"
            checked={settings.workspace.allowEdit}
            onChange={(value) => {
              if (!value) {
                update({ workspace: { allowEdit: false } });
                return;
              }
              // 已经选了目录：顺带把浏览器的写入授权要下来（手势就在这次点击里）。
              // 还没选目录则不必——选择目录时本来就会按当时的开关一并要权限
              if (workspace.root === null) {
                update({ workspace: { allowEdit: true } });
                return;
              }
              void authorizeWrite().then((granted) => {
                if (granted) update({ workspace: { allowEdit: true } });
              });
            }}
          />
        </SettingRow>
        <SettingRow
          label="浏览器写入授权"
          help="浏览器对目录的授权分「读」与「写」两种，写入授权只在你的点击动作里才能申请到，且重开浏览器后可能失效。开关开着但这里显示未授权时，AI 写文件会失败"
        >
          <div className={styles.inline}>
            <span className={styles.aboutValue}>
              {workspace.root === null
                ? '尚未选择工作区'
                : workspace.writeState === 'granted'
                  ? '已授权写入'
                  : '未授权（AI 无法写文件）'}
            </span>
            {workspace.root !== null && workspace.writeState !== 'granted' ? (
              <button
                type="button"
                className={styles.miniBtn}
                onClick={() => void authorizeWrite()}
              >
                授权写入
              </button>
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          label="目录访问能力"
          help="由宿主提供。浏览器端基于 File System Access API，只能拿到目录句柄、拿不到真实路径，所以界面上显示的是目录名"
        >
          <span className={styles.aboutValue}>
            {workspace.supported ? '可用（Chromium 内核）' : workspace.unsupportedReason}
          </span>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
