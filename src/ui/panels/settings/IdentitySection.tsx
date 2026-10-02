import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { AvatarEditor } from '@ui/components/AvatarEditor';
import { SettingGroup, SettingRow, TextField } from '@ui/primitives';

interface IdentitySectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/** 身份分区（从 `SettingsPanel` 逐字搬出，未改语义） */
export function IdentitySection({ settings, update }: IdentitySectionProps) {
  return (
    <>
      <SettingGroup
        title="身份"
        help="AI 与你的名字、头像；会替换预设词里的 {{char}} 与 {{user}}"
      >
        <SettingRow label="AI 的名字" help="宏 {{char}} 会替换成这个名字">
          <TextField
            width={220}
            value={settings.identity.assistantName}
            onChange={(value) => update({ identity: { assistantName: value } })}
          />
        </SettingRow>
        <SettingRow label="你的名字" help="宏 {{user}} 会替换成这个名字">
          <TextField
            width={220}
            value={settings.identity.userName}
            onChange={(value) => update({ identity: { userName: value } })}
          />
        </SettingRow>
        <SettingRow
          label="AI 头像"
          help="图片优先 > emoji > 名称首字 > 只显示底色。角色预设里配了头像的话，角色优先"
        >
          <AvatarEditor
            value={settings.identity.assistantAvatar}
            onChange={(next) => update({ identity: { assistantAvatar: next } })}
            name={settings.identity.assistantName}
          />
        </SettingRow>
        <SettingRow label="你的头像">
          <AvatarEditor
            value={settings.identity.userAvatar}
            onChange={(next) => update({ identity: { userAvatar: next } })}
            name={settings.identity.userName}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
