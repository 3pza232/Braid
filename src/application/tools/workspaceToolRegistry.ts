import { appError, err, ok, type Result } from '@shared/result';
import type { ToolCall } from '@domain/entities/message';
import { SAMPLING_CONSTRAINTS } from '@domain/value-objects/sampling';
import type { ProviderTool } from '@ports/LLMProvider';
import type { WorkspaceApi } from '@ports/WorkspaceApi';

/**
 * 文件工具集 + 执行器
 *
 * 【为什么"执行结果"是内容而不是错误对象】
 * 工具失败**不是**程序错误，它是对话的一部分：模型需要知道"写失败了，因为没权限"，
 * 然后才能换做法（请求用户开权限、或只读不写）。所以 `run()` 从不抛异常、
 * 也不返回 `Result` —— 它总是返回一段**给模型看的话**，加上一个 isError 标记
 * （标记只用于界面着色与消息序列里的【失败】前缀）。
 *
 * 只有一种情况算程序错误：工具名不认识。那说明模型编了一个不存在的工具，
 * 同样要以内容形式告诉它，而不是让整轮崩掉。
 */

export interface ToolRunResult {
  content: string;
  isError: boolean;
}

export interface ToolRegistry {
  /** 发给模型的工具声明。返回空数组 = 这次对话没有可用工具 */
  specs(): ProviderTool[];
  /** 执行一个调用。任何失败都变成内容回给模型 */
  run(call: ToolCall): Promise<ToolRunResult>;
  /** 附在系统提示词后面的能力说明 */
  promptSection(): string;
}

/**
 * 单次读文件返回给模型的上限
 *
 * 不设上限的话，模型读一个几十万字的稿子会把上下文一次打满，
 * 后面的对话全部无法进行 —— 而且它往往并不需要全文。
 * 截断时**明确告诉它被截断了**，否则它会基于半截内容下结论。
 */
/**
 * 「一次最多写多少」那个设置项的**显示名**，取自同一处定义（`sampling.ts`）
 *
 * 下面那段话是**给模型看的**，而模型会照着劝用户去改设置 —— 名字必须和界面上一致，
 * 否则它指着一个用户找不到的选项。改名前这里写死的是老名字「单次最大输出」，
 * 改名时漏掉了它（同一类漏改在 `streamOutcome.ts` 也有一处，那边已改成同一个常量）。
 */
const MAX_OUTPUT_LABEL = SAMPLING_CONSTRAINTS.maxTokens.label;

const MAX_READ_CHARS = 20_000;

/** 列目录返回给模型的上限 */
const MAX_LIST_ENTRIES = 200;

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 需要**编辑权限**的写类工具 */
  mutating: boolean;
  execute(args: Record<string, unknown>, workspace: WorkspaceApi): Promise<Result<string>>;
}

/* ────────────────────────── 参数读取 ────────────────────────── */

/**
 * 从模型给的参数里取字符串
 *
 * 一律当作**不可信输入**：模型会给出 `null`、数字、嵌套对象，
 * 甚至漏掉必填项。读不到就返回 null，由调用方给出一句人话的错误。
 */
function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * 取出工具参数；`null` = 参数不是完整 JSON，**不能执行**
 *
 * 【为什么不能"解析失败就给个空对象"】
 * 流式拼接出来的 arguments 有可能是不完整的 JSON，最常见的原因是
 * **「单轮输出上限」把参数截断了** —— 写一个较长文件时尤其容易撞上。
 *
 * 早先这里退回 `{}` 继续执行，于是 `execute` 里看到 `path` 是 undefined，
 * 报出来的是「缺少参数 path」。那句话把诊断引到了完全错误的方向：
 * 用户会去怀疑"是不是不支持相对路径"，而真正的原因是参数根本没传完，
 * 模型与用户都在同一个错误结论上打转。
 *
 * 注意区分两种"空"：`{}`（合法 JSON、真的没有参数，如 `list_dir()`）
 * 与解析失败（参数残缺）—— 前者放行，后者拦住。
 */
function readArgs(call: ToolCall): Record<string, unknown> | null {
  // `parsed` 由 createToolCall 解析好了；失败时它是 undefined
  if (call.parsed && typeof call.parsed === 'object' && !Array.isArray(call.parsed)) {
    return call.parsed as Record<string, unknown>;
  }
  return null;
}

/* ────────────────────────── 工具定义 ────────────────────────── */

const listDir: ToolDefinition = {
  name: 'list_dir',
  description:
    '列出工作区内某个目录的文件与子目录。path 省略时列出工作区根目录。返回每项的相对路径、类型与文件大小。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的目录路径，例如 "小说/第一卷"。省略表示根目录' },
    },
    required: [],
  },
  mutating: false,
  async execute(args, workspace) {
    const path = readString(args, 'path') ?? '';
    const result = await workspace.listFiles(path);
    if (!result.ok) return err(result.error);

    if (result.data.length === 0) return ok('（空目录）');

    const shown = result.data.slice(0, MAX_LIST_ENTRIES);
    const lines = shown.map((entry) => {
      const suffix = entry.kind === 'directory' ? '/' : '';
      const size = entry.size === null ? '' : `  ${entry.size} 字节`;
      return `${entry.path}${suffix}${size}`;
    });
    const more =
      result.data.length > shown.length
        ? `\n…另有 ${result.data.length - shown.length} 项未列出`
        : '';
    return ok(`${result.data.length} 项：\n${lines.join('\n')}${more}`);
  },
};

const readFile: ToolDefinition = {
  name: 'read_file',
  description: '读取工作区内一个文本文件的内容。超出长度上限时会截断并注明。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的文件路径，例如 "小说/第一章.txt"' },
    },
    required: ['path'],
  },
  mutating: false,
  async execute(args, workspace) {
    const path = readString(args, 'path');
    if (path === null || path.trim().length === 0) {
      return err(appError('TOOL_INVALID_INPUT', '缺少参数 path'));
    }

    const result = await workspace.readFile(path);
    if (!result.ok) return err(result.error);

    if (result.data.length === 0) return ok('（空文件）');
    if (result.data.length > MAX_READ_CHARS) {
      return ok(
        `${result.data.slice(0, MAX_READ_CHARS)}\n\n…（文件共 ${result.data.length} 字符，已截断，只显示了前 ${MAX_READ_CHARS} 字符）`,
      );
    }
    return ok(result.data);
  },
};

const writeFile: ToolDefinition = {
  name: 'write_file',
  description:
    '把内容写入工作区内的一个文件（覆盖已有内容）。**缺少的中间目录会自动创建**，所以新建目录+写文件一次就能完成。**仅在用户明确要求把内容保存成文件、或明确让你写某个文件时使用**；用户只是要长文/长回答时请直接写在回复里。需要用户已开启「允许编辑工作区文件」。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于工作区根目录的文件路径，例如 "小说/第一章.txt"' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  mutating: true,
  async execute(args, workspace) {
    const path = readString(args, 'path');
    const content = args['content'];
    if (path === null || path.trim().length === 0) {
      return err(appError('TOOL_INVALID_INPUT', '缺少参数 path'));
    }
    if (typeof content !== 'string') {
      return err(appError('TOOL_INVALID_INPUT', '缺少参数 content'));
    }

    // 门禁在 WorkspaceService.writeFile 里：未授权时这里拿到的是 FS_EDIT_DENIED，
    // 它的 message 已经是一句能直接讲给模型听的话
    const result = await workspace.writeFile(path, content);
    if (!result.ok) return err(result.error);
    return ok(`已写入 ${path}（${content.length} 字符）`);
  },
};

const DEFINITIONS: readonly ToolDefinition[] = [listDir, readFile, writeFile];

/* ────────────────────────── 注册表 ────────────────────────── */

export function createWorkspaceToolRegistry(workspace: WorkspaceApi): ToolRegistry {
  const byName = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

  /**
   * 只有在"工作区可用"时才把工具发出去
   *
   * 这是刻意的：**不发**等于告诉模型"你没有这个能力"，
   * 它会直接说"我无法读写文件"；而发了却每次都失败，只会浪费一轮请求
   * 并让用户看到一串报错。
   */
  const available = (): boolean => {
    const snapshot = workspace.snapshot();
    return snapshot.supported && snapshot.root !== null && snapshot.canRead;
  };

  return {
    specs() {
      if (!available()) return [];
      return DEFINITIONS.map((definition) => ({
        type: 'function',
        function: {
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        },
      }));
    },

    async run(call) {
      const definition = byName.get(call.name);
      if (!definition) {
        const names = DEFINITIONS.map((item) => item.name).join(' / ');
        return { content: `没有名为 ${call.name} 的工具。可用工具：${names}`, isError: true };
      }

      if (!available()) {
        return {
          content: '当前会话没有可用的工作区目录，文件工具不可用。请用户先在会话设置里选择工作区目录。',
          isError: true,
        };
      }

      const args = readArgs(call);
      if (args === null) {
        /*
         * 参数残缺时把**可能的原因与下一步**说清楚，而不是含糊地"参数非法"。
         * 这句话模型也会读到 —— 它据此才知道该缩小写入量，而不是换个路径再试一次。
         */
        return {
          content: [
            `工具 ${call.name} 的参数不是完整的 JSON，这次调用无法执行。`,
            `最常见的原因是「${MAX_OUTPUT_LABEL}」把参数截断了（写入很长的内容时尤其容易）。`,
            `可行的做法：把「${MAX_OUTPUT_LABEL}」调大；或者把内容分成几次写入`,
            '（第一次建立文件，后续用同一个路径继续补写）。',
            '注意：这不代表路径写法有问题，相对路径本身是支持的。',
          ].join(''),
          isError: true,
        };
      }

      try {
        const result = await definition.execute(args, workspace);
        return result.ok ? { content: result.data, isError: false } : { content: result.error.message, isError: true };
      } catch (error) {
        // 兜底：工具内部真出了 bug 也不该把整轮对话打断，而是变成一句可读的失败
        const detail = error instanceof Error ? error.message : String(error);
        return { content: `工具执行失败：${detail}`, isError: true };
      }
    },

    promptSection() {
      const snapshot = workspace.snapshot();
      const lines: string[] = ['【工作区与文件工具】'];

      if (!snapshot.supported) {
        lines.push(`- 当前环境不支持访问本地目录（${snapshot.unsupportedReason ?? '原因未知'}），文件工具不可用。`);
        return lines.join('\n');
      }
      if (snapshot.root === null) {
        lines.push('- 本会话**尚未选择工作区目录**，因此没有文件工具可用。需要读写文件时，请让用户先在顶栏或会话设置里选择目录。');
        return lines.join('\n');
      }

      /*
       * 目录选了、但浏览器还没放行时，这一段必须和 `specs()` 说**同一句话**
       *
       * `specs()` 发不发工具声明，看的是 `canRead`（选了目录 **且** 已授权读）。
       * 这里早先只看"选没选目录"，于是会出现最坏的一种组合：系统提示词里
       * 明明白白列着三个可用工具，而这次请求**根本没带 tools 字段** ——
       * 模型据此向用户宣称"我可以读你的文件"，一调用就什么都没有。
       * 重开浏览器后目录授权常常需要重新确认，这条路径是会走到的。
       */
      if (!snapshot.canRead) {
        lines.push(
          '- 目录已选，但**本次没有授予访问权限**（重开浏览器后可能需要重新确认），因此这一轮**没有任何文件工具可用**。请让用户点一次「重新授权」；在此之前不要尝试读写文件，也不要向用户承诺你能读。',
        );
        return lines.join('\n');
      }

      /*
       * 顺序有讲究：**稳定的内容在前，随状态变化的内容在后**
       *
       * 提示词缓存是"最长公共前缀"匹配，而这一整段位于消息数组的**最前面** ——
       * 一旦中间插入了会变的内容（目录名、权限状态），它后面的全部内容
       * 每轮都会失效，缓存命中率会莫名其妙掉到 0。
       * 把固定的工具说明、路径规则放前面，把会变的状态放最后，
       * 这样变化只影响尾部，前面的前缀仍然能命中。
       */
      lines.push('- 可用工具：`list_dir(path)`、`read_file(path)`、`write_file(path, content)`');
      /*
       * 「只在被要求时动手」这一条必须写在这里，而且要说透
       *
       * 真实出现过：用户只是想让它写一段长内容，它却把正文写进了文件 ——
       * 因为它读到的信号是"有 write_file 这个工具、而且标注着已授权、无需再询问"，
       * 于是把"可以写"当成了"应该写"。工具在场本身就是一种行为邀请，
       * 所以必须显式说明**什么时候不该用它**，光说"你有权限"是不够的。
       */
      lines.push(
        '- 使用原则：**只在用户明确要求读写文件时使用这些工具**。用户要长文、长回答时，请直接把内容写在回复里 —— 不要"顺便"保存成文件，也不要因为存在 `write_file` 就替他决定落盘。',
      );
      lines.push('- 路径一律使用**相对于工作区根目录**的相对路径（如 `小说/第一章.txt`），不要用绝对路径，不要用 `..`。越界路径会被直接拒绝。');
      lines.push('- `write_file` 会自动创建缺失的中间目录，因此"新建目录并写入文件"不需要额外的建目录工具。');
      lines.push(`- 工作区目录：${snapshot.root.label}（浏览器不提供完整路径，这是目录名）`);
      /*
       * 把"为什么现在不能写"讲到**能直接照做**的程度
       *
       * 两种情况要用户做的事完全不同（去开开关 vs 去点授权），
       * 混成一句"没权限"会让模型反复重试、让用户到处找。
       */
      /*
       * 只剩一件事要交代：**能不能写**
       *
       * "允不允许"这个概念已经不存在了 —— 选中工作区就是给了读写权
       * （见 `WorkspaceService.writeFile` 的说明）。所以这里要么说能写，
       * 要么说清缺的是浏览器那一层的放行、以及用户该点哪里。
       */
      if (snapshot.writeState !== 'granted') {
        lines.push(
          '- **浏览器还没授予这个目录的写入权限**：请让用户点一次「授权写入」（浏览器只认用户的点击动作，模型无法自己申请）。在此之前 `write_file` 会失败，**不要反复重试**。',
        );
      } else {
        // 措辞刻意不同于"可以直接写文件，无需再询问"：那句话说出来的效果是**邀请**，
        // 而这里要表达的是"有权限"，两者在长文场景下会导出完全不同的行为
        lines.push('- 读写权限：已就绪（**能写不等于该写** —— 仍需用户明确要求）。');
      }
      return lines.join('\n');
    },
  };
}
