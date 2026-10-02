import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createContainer } from '@bootstrap/createContainer';
import { builtinThemes } from '@adapters/themes';
import { loadRuntimeThemes } from '@adapters/themes/externalThemes';
import { BraidProvider } from '@ui/BraidProvider';
import { useStorageStore } from '@ui/stores/storageStore';
import { takeImportSummary } from '@ui/utils/importSummary';
import { useUiStore } from '@ui/stores/uiStore';
import { App } from './App';
import '@ui/styles/global.css';

/**
 * 应用入口
 *
 * 顺序很重要：
 *  1. 取外置主题（桌面版从 exe 同级的 `themes/` 读；浏览器里没有这一步，是个 404）；
 *  2. 装配组合根（container）—— 其余部分纯同步，毫秒级；
 *  3. 挂载 React —— 保证首屏立刻可见，不被 WASM 与建表拖慢；
 *  4. 存储初始化在后台跑（建表迁移 + 历史数据导入），完成后写入 store 供「关于」展示。
 *
 * 第 1 步为什么在挂载**之前**：主题列表在 `ThemeProvider` 渲染时就要用（设置面板要列出
 * 可选项），而主题注册表不通知订阅者 —— 挂载之后再注册，用户得刷新一次才看得到新主题。
 * 它不会把首屏拖住：同源/本机请求，且失败与超时都按"没有运行时目录"处理。
 *
 * 关键：仓储拿到的是**就绪门控**过的 SqlPort，任何查询都会自动等待第 4 步完成，
 * 所以"立刻挂载"不会导致"查到不存在的表"。迁移失败也不会阻断启动，
 * 应用仍可使用，界面会显示原因。
 */
async function bootstrap(): Promise<void> {
  const runtimeThemes = await loadRuntimeThemes(builtinThemes);
  const container = createContainer(runtimeThemes === null ? {} : { runtimeThemes });

  const mountPoint = document.getElementById('root');
  if (!mountPoint) throw new Error('[bootstrap] 找不到 #root 挂载点');

  createRoot(mountPoint).render(
    <StrictMode>
      <BraidProvider container={container}>
        <App />
      </BraidProvider>
    </StrictMode>,
  );

  void container.storageReady.then((status) => {
    useStorageStore.getState().set(status);
  });

  /*
   * 上一次备份导入的汇总
   *
   * 那条通知是在 `location.reload()` **之前**推的，会被重载立刻冲掉，
   * 所以它被寄存在 sessionStorage 里等着在这里重新出现（见 `ui/utils/importSummary`）。
   * 导入了多少、跳过了多少、丢了什么 —— 这些用户只能从这一句话里看到。
   */
  const importSummary = takeImportSummary();
  if (importSummary !== null) {
    useUiStore.getState().pushNotice({ tone: 'alert', message: importSummary });
  }

  /*
   * 多标签页：本页如果是"后开的那个"，把风险说清楚
   *
   * 两个标签页各持一份连接写同一个 OPFS 上的库 —— 这件事在应用层是**未知**的
   * （见 ports/host/InstanceLock）。未知就别装作没事：明确告诉用户，
   * 而不是等数据坏了再让人猜。判定本身很快，所以不必阻塞首屏。
   */
  void container.instanceLock.role().then((role) => {
    if (role !== 'secondary') return;
    useUiStore.getState().pushNotice({
      tone: 'alert',
      message:
        '检测到另一个标签页也在使用这份数据。两个标签页同时写入可能导致数据错乱，建议只保留一个。',
    });
  });
}

// `bootstrap` 现在是异步的（第一步要取外置主题）。不 await 是刻意的：
// 挂载时机由它内部掌握，这里再包一层 then 只会多一处无处安放的错误分支。
void bootstrap();
