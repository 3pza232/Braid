import {
  isValidElement,
  memo,
  useDeferredValue,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import xml from 'highlight.js/lib/languages/xml';
// 全局样式：高亮令牌的类名是运行时注入的，不能放进 CSS Module（会被哈希掉）
import '@ui/styles/highlight.css';
import { COPY_FAILED_MESSAGE, copyText } from '@ui/utils/clipboard';
import { useUiStore } from '@ui/stores/uiStore';
import styles from './Markdown.module.css';

/**
 * 正文渲染（Markdown + 代码高亮）
 *
 * 【为什么必须有】
 * 模型回的东西天生是 Markdown：代码块、列表、表格、粗体。按纯文本显示时，
 * 表格会塌成一行竖线、代码没有高亮也没法一键复制、列表失去层级 ——
 * 这些损耗每一次对话都在发生。
 *
 * 【为什么用 react-markdown 而不是 markdown-it + innerHTML】
 * 它是把 Markdown 转成 **React 元素**，天然不解析裸 HTML，
 * 所以模型输出里的 `<script>` / `<img onerror>` 不可能被执行。
 * 换成"解析成 HTML 字符串再塞进 DOM"的方案，就等于把模型输出当代码运行 ——
 * 在这个应用里那意味着它能碰到本地的数据库与 API Key。
 */

/*
 * 额外语言
 *
 * 内置的 common 已覆盖 js/ts/py/cpp/c/lua/json/yaml/bash/sql/rust/go/java/
 * html/css/markdown 等三十来种；这里补三个常用的，
 * 并把 vue 交给 xml —— 单文件组件本质是 HTML 超集，这样着色是对的。
 * 插件数组放在**模块级**：每次渲染新建数组会让 react-markdown 每帧重跑插件。
 */
const extraLanguages = { powershell, dart, dockerfile, vue: xml };
const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [remarkGfm];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { detect: false, languages: extraLanguages }],
];

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** 从 `<pre>` 的孩子（那个 `<code>`）里读语言标记 */
function languageOf(children: ReactNode): string {
  if (!isValidElement(children)) return '';
  const className = (children.props as { className?: string }).className ?? '';
  const matched = /language-([\w+#-]+)/.exec(className);
  return matched?.[1] ?? '';
}

/**
 * 代码块：语言标签 + 一键复制
 *
 * 复制按钮是这类渲染里**最常被用到**的一个功能（拿代码去跑），
 * 所以它不藏在悬浮菜单里，而是常驻在代码块右上角。
 */
function CodeBlock({ children }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false);
  const language = languageOf(children);

  const copy = () => {
    /*
     * 只有**真的复制成功**才显示"已复制"
     *
     * 早先无论如何都显示：非 HTTPS 下 `navigator.clipboard` 是 undefined，
     * 按钮照样说"已复制"，用户去粘贴发现是空的 —— 一个会骗人的反馈比没有反馈更糟。
     */
    void copyText(extractText(children)).then((copied) => {
      if (!copied) {
        useUiStore.getState().pushNotice({ tone: 'error', message: COPY_FAILED_MESSAGE });
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBar}>
        <span className={styles.codeLang}>{language || 'text'}</span>
        <button type="button" className={styles.copyBtn} onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: ComponentProps<typeof ReactMarkdown>['components'] = { pre: CodeBlock };

/**
 * 正文
 *
 * `useDeferredValue` 是这里的关键：流式输出每 120ms 就换一次文本，
 * 而 Markdown 解析 + 高亮是实打实的 CPU 开销 —— 直接同步渲染会让
 * 长回答在生成过程中明显卡顿。延迟值让 React 先用旧内容渲染，
 * 有空了再追上最新文本，视觉上几乎无感，主线程却轻松得多。
 */
function MarkdownView({ text }: { text: string }) {
  const deferred = useDeferredValue(text);

  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {deferred}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownView);
