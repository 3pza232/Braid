# 余额查询脚本

Braid **不内置任何厂商的余额接口**：请求哪个地址、怎么解析响应，全由你写一段 JS 决定。
这样加服务商不需要改代码，也不会把"某家 API 的形状"漏进核心。

脚本在 **设置 → 模型与凭据** 里配置，并且**跟着模型配置走** —— 不同端点的余额接口
完全不同，把它们分在两张页面里，改端点时必然会忘了改脚本。

## 脚本的形状

一个**对象字面量表达式**，两个字段：

```js
({
  request: {
    url: 'https://api.example.com/user/balance',
    method: 'GET',                              // 省略即 GET
    headers: { Authorization: 'Bearer {{apiKey}}' },
    body: undefined,                            // 有值时会 JSON.stringify
  },
  // 入参是接口返回的 JSON；返回 { isValid, remaining, unit } 即可
  extractor: function (response) {
    return {
      isValid: response.ok === true,
      remaining: Number(response.data?.balance ?? 0),
      unit: 'CNY',
    };
  },
})
```

## 占位符

| 占位 | 替换成 |
|---|---|
| `{{apiKey}}` | 当前模型配置里的 API Key |
| `{{baseUrl}}` | 当前模型配置里的 Base URL |

用占位符而不是把密钥写死在文本里：**导出的设置与分享出去的脚本不会连密钥一起泄漏**。

## 求值与安全边界

- 脚本用 `new Function('"use strict"; return (' + 脚本 + ')')` 求值 ——
  **只求一个表达式**，不提供任何额外参数，尽量缩小它的能力面；
- 但它仍然运行在**你的页面里**，拥有页面权限：只粘贴你自己看得懂的脚本；
- 脚本只来自你在设置里粘贴的内容，不会从任何外部来源加载；
- **产物里的内容安全策略必须允许 `'unsafe-eval'`**（见 `vite.config.ts` 的 `contentSecurityPolicy`）：
  这个功能本身就是"执行用户写的 JS"，少了那一项，浏览器里开发一切正常、**装进 exe 就报错** ——
  而这个坑已经踩过一次。更要紧的是当时的报错文案会说"请检查括号与引号是否配对"，
  把用户送去查一个根本没写错的地方（现在两者已经分开报，见 `scriptBalanceProvider`）。
  `npm run desktop:smoke` 会**实际执行一次 `new Function`** 来守住这条 —— 只检查 CSP 文本里
  有没有那串字是不够的（这次就是文本对了、能力被拦了）。

## extractor 的返回值怎么被处理

`normalizeBalanceResult` 从返回对象里安全地取字段，缺什么补什么：

| 字段 | 规则 | 缺失时 |
|---|---|---|
| `isValid` | 必须严格是 `true` 才算有效 | `false` |
| `remaining` | 有限数字才采纳 | `null`（顶栏显示"未启用/无数据"） |
| `unit` | 字符串 | 空串 |

返回的不是对象 → 记一条「脚本没有返回对象」。

## 失败与超时

| 情况 | 结果 |
|---|---|
| 脚本括号/引号不配对 | 「余额脚本无法解析，请检查括号与引号是否配对」+ 原始错误 |
| 缺 `request.url` | 「余额脚本缺少 request.url」 |
| 缺 `extractor` 函数 | 「余额脚本缺少 extractor 函数」 |
| HTTP 非 2xx | `isValid: false`，`error: "HTTP 404"`（**不看响应体**） |
| 超过 15 秒（`timeoutMs`） | `error: "请求超时"` |
| 跨域 / 地址不可达 / 响应体不是 JSON | 归一化成网络类错误的中文提示 |

失败**不会抛给上层**：都收敛成一个 `BalanceSnapshot`（带 `error` 字段）显示在顶栏，
不会打断对话。

## 何时刷新

- 点顶栏的余额区域（手动刷新，按钮在请求期间禁用并显示忙碌态）；
- 打开 `balance.autoRefresh` 后按 `balance.refreshIntervalMs` 的间隔自动刷新。

## 实现落点

| 位置 | 职责 |
|---|---|
| `domain/value-objects/billing.ts` | 脚本示例、`BalanceSnapshot`、结果归一化、金额格式化 |
| `application/balance/BalanceService.ts` | 取脚本、调提供方、缓存最近一次结果并广播 |
| `adapters/balance/scriptBalanceProvider.ts` | 真正执行脚本：替换占位符、求值、fetch、超时 |
| `ui/panels/settings/ModelSection.tsx` | 脚本编辑框与"已配置/未配置"提示 |
| `ui/components/TopBar.tsx` | 展示剩余额度、手动/自动刷新 |
