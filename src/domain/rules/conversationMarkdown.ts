import type { Conversation } from '@domain/entities/conversation';
import type { MessageNode } from '@domain/entities/message';
import { activePathOf, buildTreeIndex } from '@domain/rules/messageTree';

/**
 * 会话导出为 Markdown
 *
 * 【为什么是纯函数、放在 domain】
 * "哪些消息在导出范围内"（激活路径、跳过软删除）、"工具调用怎么呈现"
 * 都是**规则**，与文件对话框、按钮无关。放在这里就能直接跑用例，
 * 也能被将来的其它导出格式（纯文本、JSON 单会话）复用同一套筛选。
 *
 * 【只导出当前激活的那条线】
 * 编辑与"重新生成"会在库里留下旧分支（那是分支功能的正常产物）。
 * 把它们一起导出来，读者会看到前后矛盾的对话，而用户点"导出"想要的是
 * **他眼前正在看的这段**。需要全部分支时应该用整库备份。
 */
export interface ConversationMarkdownInput {
  conversation: Conversation;
  /** 该会话的全部节点（含旧分支与软删除的，函数内部会筛） */
  nodes: readonly MessageNode[];
  /** 导出时刻（注入而不是现取，测试才能稳定） */
  exportedAt: number;
}

const ROLE_LABEL: Record<MessageNode['role'], string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
};

/** 时间统一用 UTC 表示：本地时区会让同一份数据在不同机器上导出成不同文本 */
function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

export function conversationToMarkdown(input: ConversationMarkdownInput): string {
  const { conversation, exportedAt } = input;
  const visible = input.nodes.filter((node) => node.deletedAt === null);
  const path = activePathOf(buildTreeIndex(visible), conversation.activeRootChildId);

  const lines: string[] = [];
  lines.push(`# ${conversation.title}`, '');

  const roleName = conversation.roleInstance?.name ?? null;
  lines.push('---', '');
  if (roleName) lines.push(`- 角色：${roleName}`);
  lines.push(`- 消息：${path.length} 条`);
  lines.push(`- 导出时间：${stamp(exportedAt)}（UTC）`);
  lines.push('', '---', '');

  for (const node of path) {
    lines.push(`## ${ROLE_LABEL[node.role]} · ${stamp(node.createdAt)}`, '');

    for (const segment of node.segments) {
      if (segment.kind === 'text') {
        lines.push(segment.text, '');
      } else if (segment.kind === 'reasoning') {
        // 思考过程用引用块：它是过程性内容，读者要能一眼分辨"这不是回答"
        lines.push(...segment.text.split('\n').map((row) => `> ${row}`), '');
      } else if (segment.kind === 'tool_call') {
        lines.push(`> 调用工具 \`${segment.call.name}\``, '');
      } else if (segment.kind === 'tool_result') {
        const state = segment.isError ? '失败' : '成功';
        lines.push(`> 工具 \`${segment.name}\` ${state}`, '');
      } else if (segment.kind === 'summary') {
        lines.push(`> （此处为压缩纪要，覆盖 ${segment.coversMessageIds.length} 条消息）`, '');
      }
      // 图片段落暂无可渲染的形态：跳过而不是输出一个读不懂的占位符
    }
  }

  // 结尾留一个换行：很多编辑器会把"文件最后没有换行"当成一次未提交的修改
  return `${lines.join('\n').trimEnd()}\n`;
}
