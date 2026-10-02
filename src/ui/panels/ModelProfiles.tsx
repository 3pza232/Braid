import { useState } from 'react';
import {
  activeProfileOf,
  createModelProfile,
  MAX_MODEL_NAME_LENGTH,
  type ModelProfile,
} from '@domain/value-objects/appSettings';
import { Dropdown, SettingRow, Switch, TextField, Tooltip } from '@ui/primitives';
import { useContainer } from '@ui/BraidProvider';
import { useSettingsStore } from '@ui/stores/settingsStore';
import { useUiStore } from '@ui/stores/uiStore';
import styles from './ModelProfiles.module.css';

/**
 * 模型配置的「选择 / 增删 / 命名 / 连通性测试」
 *
 * 一份配置 = 端点 + 凭据 + 模型名 + 余额脚本。它们打包在一起而不是分三个设置页，
 * 是因为**换端点必然同时换 Key 也可能换余额接口**，分开摆用户一定会漏改。
 *
 * 编辑是**即时生效**的（没有"确定/取消"），所以「测试连接」不是保存的前置门禁，
 * 而是一把随时可用的尺子：改完点一下就知道对不对。
 * 之所以不做"测试通过才让保存"：那会逼用户在改了错别字之后也得先联网才能保存，
 * 反而更容易丢东西。
 */
export function ModelProfiles() {
  const container = useContainer();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const profiles = settings.model.profiles;
  const profile = activeProfileOf(settings);
  if (!profile) return null;

  const patch = (partial: Partial<ModelProfile>) => {
    setResult(null);
    update({
      model: {
        profiles: profiles.map((item) =>
          item.id === profile.id ? { ...item, ...partial } : item,
        ),
      },
    });
  };

  const addProfile = () => {
    /*
     * 从当前配置复制一份，但**清掉与"身份"绑定的两样东西**：
     *  - API Key：属于某个账号，复制过来只会让人误以为已经配好了；
     *  - 余额脚本：它是**按端点的余额接口**写的，换了端点必然要重写。
     * 保留端点/超时/额外字段这些"结构性的东西"，换服务商时能少填几格。
     */
    const created = createModelProfile({
      ...profile,
      id: undefined,
      name: `${profile.name} 副本`,
      apiKey: '',
      balance: { ...profile.balance, script: '', autoRefresh: false },
    });
    update({
      model: { profiles: [...profiles, created], activeProfileId: created.id },
    });
    setResult(null);
  };

  const removeProfile = () => {
    /*
     * 删除是**一击就没了**（连带地址、密钥、余额脚本），所以给一条带"撤销"的通知：
     * 正常操作不必多按一次确认，做错了还能一步撤回。
     */
    const removed = profile;
    const rest = profiles.filter((item) => item.id !== profile.id);
    update({
      model: {
        profiles: rest,
        activeProfileId: rest[0]?.id ?? '',
      },
    });
    setResult(null);
    useUiStore.getState().pushNotice({
      tone: 'alert',
      message: `已删除模型配置「${removed.name}」`,
      action: {
        label: '撤销',
        run: () => update({ model: { profiles, activeProfileId: removed.id } }),
      },
    });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    const outcome = await container.provider.probe(
      {
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        requestTimeoutMs: profile.requestTimeoutMs,
        extraBodyJson: profile.extraBody,
      },
      profile.model,
    );
    setTesting(false);
    setResult(
      outcome.ok
        ? { ok: true, text: `连接成功 · ${outcome.data.latencyMs} ms` }
        : { ok: false, text: outcome.error.message },
    );
  };

  return (
    <>
      <SettingRow
        label="模型配置"
        help="一套端点 + 凭据 + 模型名 + 余额脚本；换服务商整份切换"
      >
        <div className={styles.inlineField}>
          <Dropdown
            value={profile.id}
            width={180}
            onChange={(id) => {
              setResult(null);
              update({ model: { activeProfileId: id } });
            }}
            options={profiles.map((item) => ({
              value: item.id,
              label: item.name || item.model || '未命名',
            }))}
          />
          <button type="button" className={styles.miniBtn} onClick={addProfile}>
            添加
          </button>
          <Tooltip label="删除当前配置">
            <button
              type="button"
              className={styles.miniBtn}
              disabled={profiles.length <= 1}
              onClick={removeProfile}
            >
              删除
            </button>
          </Tooltip>
        </div>
      </SettingRow>

      <SettingRow label="配置名称" help="只用于在会话里挑选，不发给模型">
        {/* 配置名要挤进顶栏那个下拉里（一行）：超长在入口截到上限 */}
        <TextField
          width={200}
          value={profile.name}
          onChange={(value) => patch({ name: value.slice(0, MAX_MODEL_NAME_LENGTH) })}
        />
      </SettingRow>

      <SettingRow
        label="把 Key 保存到本地"
        help="关：只留在内存里，重开要重填。开：明文写进本机数据库"
      >
        <Switch
          label="把 Key 保存到本地"
          checked={profile.persistApiKey}
          onChange={(value) => patch({ persistApiKey: value })}
        />
      </SettingRow>

      <SettingRow
        label="连通性测试"
        help="发一个最小请求，一次验证地址、凭据与模型名"
      >
        {/*
          结果在**按钮左边**，与「余额脚本 → 测试脚本」保持一致：
          看结果和点按钮是两个动作，结果先出现（阅读顺序也是先读结果），
          按钮作为固定锚点落在右侧，长错误信息不会把它推来推去。
        */}
        <div className={styles.inlineField}>
          {result ? (
            <span className={styles.testResult} data-ok={result.ok}>
              {result.text}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.miniBtn}
            disabled={testing || !profile.baseUrl.trim() || !profile.model.trim()}
            onClick={() => void test()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
      </SettingRow>
    </>
  );
}
