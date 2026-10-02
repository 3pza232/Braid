import type { BalanceSnapshot } from '@domain/value-objects/billing';
import { normalizeBalanceResult } from '@domain/value-objects/billing';
import type { BalanceProbeContext, BalanceProvider } from '@ports/BalanceProvider';
import { appError, err, ok, toAppError, type Result } from '@shared/result';

interface ScriptRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface BalanceScript {
  request: ScriptRequest;
  extractor: (response: unknown) => unknown;
}

/**
 * 用户脚本驱动的余额探测
 *
 * 设计取舍：这里**故意执行用户自己写的 JS**。
 *  - 好处：不硬编码任何厂商的余额接口，用户想接什么就接什么；
 *  - 风险：脚本拥有当前页面的权限。所以界面上必须明确告知，
 *    并且脚本只从"用户自己在设置里粘贴的内容"来，不从任何外部来源加载。
 *
 * 脚本里可用 {{apiKey}} / {{baseUrl}} 占位，避免把密钥写死在脚本文本里
 * （这样导出设置、分享脚本时不会连密钥一起泄漏）。
 */
export function createScriptBalanceProvider(): BalanceProvider {
  return {
    async probe(script: string, context: BalanceProbeContext): Promise<Result<BalanceSnapshot>> {
      const trimmed = script.trim();
      if (!trimmed) return ok({ isValid: false, remaining: null, unit: '', fetchedAt: 0 });

      const substituted = trimmed
        .replaceAll('{{apiKey}}', () => context.apiKey)
        .replaceAll('{{baseUrl}}', () => context.baseUrl);

      let parsed: BalanceScript;
      try {
        // 只求值"一个对象字面量表达式"，不提供任何额外参数，减少脚本的破坏面
        const factory = new Function(`"use strict"; return (${substituted});`);
        parsed = factory() as BalanceScript;
      } catch (e) {
        /*
         * 两种失败必须分开说，否则会把用户送去查错地方
         *
         *  - `SyntaxError` = 脚本本身写错了 → "检查括号与引号"是对的；
         *  - 其它异常 = **环境拒绝了执行**（最典型：内容安全策略里没有 `'unsafe-eval'`）。
         *    这种情况脚本一个字都没写错，说"检查括号"就是误导 ——
         *    用户会对着一个完全正确的脚本反复找一晚上括号。
         *
         * 这个坑真的发生过：产物 CSP 少了 `'unsafe-eval'`，而浏览器里开发没有 CSP，
         * 于是"浏览器里好好的、装进 exe 就报错"。那条文案直接把人引偏了。
         */
        const detail = e instanceof Error ? e.message : String(e);
        return err(
          appError(
            'VALIDATION_ERROR',
            e instanceof SyntaxError
              ? '余额脚本无法解析，请检查括号与引号是否配对'
              : `当前环境拒绝执行脚本（内容安全策略）：${detail}`,
            { detail },
          ),
        );
      }

      if (!parsed || typeof parsed !== 'object' || !parsed.request || typeof parsed.request.url !== 'string') {
        return err(appError('VALIDATION_ERROR', '余额脚本缺少 request.url'));
      }
      if (typeof parsed.extractor !== 'function') {
        return err(appError('VALIDATION_ERROR', '余额脚本缺少 extractor 函数'));
      }

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), context.timeoutMs);

      try {
        const response = await fetch(parsed.request.url, {
          method: parsed.request.method ?? 'GET',
          headers: parsed.request.headers ?? {},
          ...(parsed.request.body !== undefined ? { body: JSON.stringify(parsed.request.body) } : {}),
          signal: controller.signal,
        });

        const raw: unknown = await response.json();

        if (!response.ok) {
          return ok({
            isValid: false,
            remaining: null,
            unit: '',
            fetchedAt: Date.now(),
            error: `HTTP ${response.status}`,
          });
        }

        return ok(normalizeBalanceResult(parsed.extractor(raw), Date.now()));
      } catch (e) {
        // 复用共享的错误归一化：它已经处理了 AbortError → 'ABORTED' 的判定，
        // 不必在这里再手写一遍 DOMException 判断。
        const normalized = toAppError(e, '网络请求失败（可能是跨域限制或地址不可达）');
        return ok({
          isValid: false,
          remaining: null,
          unit: '',
          fetchedAt: Date.now(),
          error: normalized.code === 'ABORTED' ? '请求超时' : normalized.message,
        });
      } finally {
        window.clearTimeout(timer);
      }
    },
  };
}
