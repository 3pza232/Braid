import { useState } from 'react';

import type { AppSettings, AppSettingsPatch } from '@domain/value-objects/appSettings';
import { MAX_MODEL_NAME_LENGTH } from '@domain/value-objects/appSettings';
import { BALANCE_SCRIPT_EXAMPLE } from '@domain/value-objects/billing';
import { NumberField, SettingGroup, SettingRow, Switch, TextArea, TextField } from '@ui/primitives';
import { useBalanceStore } from '@ui/stores/balanceStore';
import { useUiStore } from '@ui/stores/uiStore';
import { ModelProfiles } from '../ModelProfiles';
import { patchBalance, patchProfile, profileOf } from './modelEdits';
import styles from './sections.module.css';

interface ModelSectionProps {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => void;
}

/** 模型与凭据分区（从 `SettingsPanel` 逐字搬出，未改语义） */
export function ModelSection({ settings, update }: ModelSectionProps) {
  /*
   * 密钥明文显示与余额快照都是**这个分区自己的界面状态**
   * 搬过来之后由它自己持有：放在面板里等于让面板替它记着两件它从不使用的东西。
   */
  const [revealed, setRevealed] = useState(false);

  /**
   * 换掉余额脚本（插入示例 / 清空）
   *
   * 脚本通常是用户手写的长文本，而这两个按钮一击就把它盖掉 —— 所以给一条带"撤销"的通知：
   * 正常操作一次点击就过，只有真做错了才需要那一下（比每次都弹确认框合适）。
   */
  const replaceScript = (script: string, done: string) => {
    const before = profileOf(settings).balance.script;
    update(patchBalance(settings, { script }));
    useUiStore.getState().pushNotice({
      tone: 'alert',
      message: done,
      action: {
        label: '撤销',
        run: () => update(patchBalance(settings, { script: before })),
      },
    });
  };
  const snapshot = useBalanceStore((s) => s.snapshot);
  const balanceBusy = useBalanceStore((s) => s.busy);
  const refreshBalance = useBalanceStore((s) => s.refresh);

  return (
    <>
      <SettingGroup
        title="模型与凭据"
        help="Braid 不预设任何模型提供商，也不替你做选择：模型名与端点都由你自己填写，原样发给服务端"
      >
        <ModelProfiles />

        <SettingRow
          label="默认模型名"
          help="完全自由填写，不做任何校验。新建会话默认使用它；可以在角色或会话里覆盖"
        >
          <TextField
            mono
            width={260}
            autoWidth
            value={profileOf(settings).model}
            /* 模型名会出现在顶栏徽标里（一行）：超长在入口截到上限 */
            onChange={(value) =>
              update(patchProfile(settings, { model: value.slice(0, MAX_MODEL_NAME_LENGTH) }))
            }
            placeholder="例如：deepseek-v4-flash"
          />
        </SettingRow>
        <SettingRow
          label="API 地址"
          help="OpenAI 兼容端点。留空则视为未配置，聊天会提示你先填这里"
        >
          <TextField
            mono
            full
            autoWidth
            value={profileOf(settings).baseUrl}
            onChange={(value) => update(patchProfile(settings, { baseUrl: value }))}
            placeholder="例如：https://api.deepseek.com/v1"
          />
        </SettingRow>
        <SettingRow
          label="API Key"
          help="直接填在这里。出于安全考虑默认只驻留内存 —— 不写入磁盘、不进日志；要长期保存请打开下面的「把 Key 保存到本地」（明文）"
        >
          <div className={styles.inlineField}>
            <TextField
              mono
              password={!revealed}
              type={revealed ? 'text' : 'password'}
              width={240}
              value={profileOf(settings).apiKey}
              onChange={(value) => update(patchProfile(settings, { apiKey: value }))}
              placeholder="粘贴你的 API Key"
            />
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? '隐藏' : '显示'}
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="额外请求体"
          help="一段 JSON，会合并进请求体。用于透传你的端点特有的参数，例如 {&quot;thinking&quot;: {&quot;type&quot;: &quot;enabled&quot;}}"
          stacked
        >
          <TextArea
            rows={3}
            value={profileOf(settings).extraBody}
            onChange={(value) => update(patchProfile(settings, { extraBody: value }))}
            placeholder='{ "top_k": 40 }'
          />
        </SettingRow>
        <SettingRow label="请求超时" help="单次请求的最长等待时间，超时后报错并允许重试">
          <NumberField
            value={profileOf(settings).requestTimeoutMs}
            min={5000}
            max={600000}
            step={5000}
            suffix="ms"
            width={150}
            onChange={(value) => update(patchProfile(settings, { requestTimeoutMs: value }))}
          />
        </SettingRow>
      </SettingGroup>
      <>
        <SettingGroup
          title="余额脚本"
          help="一段由你自己编写的 JS：请求哪个地址、怎么解析响应，全由你决定 —— 这样 Braid 不需要内置任何厂商的余额接口。脚本里可用 {{apiKey}} 与 {{baseUrl}} 占位，避免把密钥写死在文本里"
        >
          <SettingRow
            label="脚本内容"
            stacked
            hint={
              profileOf(settings).balance.script.trim()
                ? '已配置 · 顶栏会显示余额'
                : '未配置 · 顶栏显示为未启用'
            }
          >
            <TextArea
              mono
              rows={14}
              value={profileOf(settings).balance.script}
              onChange={(value) => update(patchBalance(settings, { script: value }))}
              placeholder="留空则不显示余额"
            />
          </SettingRow>
          <SettingRow
            label="示例"
            help="示例用的是一个常见的余额接口写法，仅作参考；填进去之后请自行改成你自己的地址与解析"
          >
            <div className={styles.inlineField}>
              <button
                type="button"
                className={styles.miniBtn}
                onClick={() => replaceScript(BALANCE_SCRIPT_EXAMPLE, '已插入示例脚本')}
              >
                插入示例脚本
              </button>
              <button
                type="button"
                className={styles.miniBtn}
                onClick={() => replaceScript('', '已清空余额脚本')}
              >
                清空
              </button>
            </div>
          </SettingRow>
          <SettingRow
            label="测试脚本"
            help="立即执行一次脚本并显示结果，用来确认地址、请求头与解析是否写对"
            hint={
              !profileOf(settings).balance.script.trim()
                ? '未配置'
                : balanceBusy
                  ? '测试中'
                  : !snapshot
                    ? '未测试'
                    : snapshot.isValid
                      ? `余额 ${snapshot.remaining ?? '—'} ${snapshot.unit}`
                      : '未通过'
            }
          >
            <div className={styles.inlineField}>
              <button
                type="button"
                className={styles.miniBtn}
                disabled={balanceBusy || !profileOf(settings).balance.script.trim()}
                onClick={refreshBalance}
              >
                {balanceBusy ? '测试中…' : '立即测试'}
              </button>
              {snapshot?.error ? (
                <span className={styles.aboutValue}>{snapshot.error}</span>
              ) : null}
            </div>
          </SettingRow>
          <SettingRow
            label="脚本约定"
            help={`脚本必须是一个对象字面量，形如：\n\n({\n  request: { url, method, headers },\n  extractor: function (response) {\n    return { isValid, remaining, unit };\n  },\n})\n\n其中 request.url 与 extractor 是必填。`}
          >
            <span className={styles.aboutValue}>request + extractor</span>
          </SettingRow>
          <SettingRow
            label="自动刷新"
            help="开启后按下面的间隔自动查询余额。注意频繁请求可能被服务端限流"
          >
            <div className={styles.inlineField}>
              <Switch
                label="自动刷新余额"
                checked={profileOf(settings).balance.autoRefresh}
                onChange={(value) => update(patchBalance(settings, { autoRefresh: value }))}
              />
              <NumberField
                value={Math.round(profileOf(settings).balance.refreshIntervalMs / 1000)}
                min={10}
                max={3600}
                step={10}
                suffix="秒"
                width={130}
                onChange={(value) =>
                  update(
                    patchBalance(settings, {
                      refreshIntervalMs: Math.max(10, value) * 1000,
                    }),
                  )
                }
              />
            </div>
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="安全提示">
          <SettingRow
            label="脚本会以本应用的权限执行"
            help="余额脚本是你自己粘贴进来的代码，Braid 会直接执行它以拼装请求。请只使用你自己信任的脚本，不要粘贴来源不明的内容。脚本不会联网之外的任何权限被自动授予，但仍请谨慎。"
          >
            <span className={styles.aboutValue}>请自行确认脚本来源</span>
          </SettingRow>
        </SettingGroup>
      </>
    </>
  );
}
