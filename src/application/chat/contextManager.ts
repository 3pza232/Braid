import { nanoid } from 'nanoid';
import type { Conversation } from '@domain/entities/conversation';
import type { TreeState } from '@domain/rules/messageTreeEdits';
import {
  buildCompressionMessages,
  describeNodes,
  estimateContextUsage,
  planCompression,
} from '@domain/rules/contextCompression';
import { activePathOf, cachedTreeIndex } from '@domain/rules/messageTree';
import { resolveConfig, type ResolvedConfig } from '@domain/rules/resolveConfig';
import {
  activeSummaryOf,
  summariesOf,
  withSummary,
  type ContextSummary,
} from '@domain/value-objects/contextSummary';
import { estimateTokens } from '@domain/value-objects/usage';
import type { ChatSnapshot, ContextCompressionReport } from '@ports/ChatApi';
import type { LLMProvider } from '@ports/LLMProvider';
import type { SettingsApi } from '@ports/SettingsApi';
import type { ConversationId, MessageId } from '@shared/ids';
import { appError, err, ok, type Result } from '@shared/result';

/**
 * 上下文：状态、发送前的闸门、压缩
 *
 * 这是从 `ChatService`（原本 1500 行、"六件事"混在一起）搬出来的**第一个协作者**。
 * 挑它的理由：它是"读若干状态 → 做一件事 → 写回"的典型，依赖面窄，
 * 而且它此前**完全没有测试**（只有纯函数部分被覆盖）。
 *
 * 【为什么不把状态一起搬过来】
 * 它会读写会话、消息树、`compressing` 这些散落在服务里的东西。与其把这些字段
 * 抽成一个共享 state 对象（那要改动整个服务的每一处引用，收益只是"看起来更整齐"），
 * 不如注入**取值函数 + 提交函数**（与 `WorkspaceService` 的 `WorkspaceScope` 同一套路）：
 * 依赖方向清楚，服务侧一个字都不用重写，模块还能单独测。
 */
export interface ContextManagerDeps {
  settings: SettingsApi;
  provider: LLMProvider;
  /** 当前会话与它的树：压缩会替换它们，所以每次都要现取 */
  activeConversation: () => Conversation;
  activeTree: () => TreeState;
  /**
   * 正在生成的那条消息 id
   *
   * 两条路径同时改树会互相覆盖，所以**界面按钮**在生成中一律被拒；
   * 只有轮次循环能带 `allowWhileStreaming` 在**轮间**压一次（见 `compress` 的说明）。
   */
  streamingId: () => MessageId | null;
  isCompressing: () => boolean;
  setCompressing: (value: boolean) => void;
  /** 顶栏那句"最近一次为塞进上下文做过什么" */
  setNote: (note: string | null) => void;
  /** 落库 + 通知界面（服务的 commit：先内存、后磁盘） */
  commit: (
    conversationId: ConversationId,
    next: TreeState,
    patch?: Partial<Conversation>,
  ) => Promise<Result<void>>;
  emit: () => void;
}

export interface ContextManager {
  /** 给界面看的用量快照 */
  status(): ChatSnapshot['context'];
  /** 到触发线了吗（纯判断，便于单测） */
  shouldAutoCompress(config: ResolvedConfig, used: number): boolean;
  /** 发送前的闸门：必要时先压缩，压完仍超限就拦住这次发送 */
  prepare(
    incoming: string,
  ): Promise<Result<{ conversation: Conversation; tree: TreeState; config: ResolvedConfig }>>;
  /** 手动压一次 */
  /**
   * 把较早的历史压成纪要
   *
   * `allowWhileStreaming` **只给轮次循环的轮间用**（见 `ChatService.runStream`）。
   * 破例成立的两个前提缺一不可：
   *  1. 此刻没有正在传输的请求（上一轮的流已经读完）；
   *  2. **正在写的那条消息压不到** —— `planCompression` 硬性保留最近一轮。
   * 所以它压的只是"更早的对话历史"，不会动用户眼前这条正在生长的回复。
   *
   * 破例的调用方**必须**在压缩后重算纪要/历史：压缩会改节点标记与会话行，
   * 拿旧引用继续，写回时会把压缩结果覆盖掉（`prepare` 的注释里是同一条约定）。
   */
  compress(options?: { allowWhileStreaming?: boolean }): Promise<Result<ContextCompressionReport>>;
}

export function createContextManager(deps: ContextManagerDeps): ContextManager {
  /**
   * 当前会话的上下文状态
   *
   * **每次快照现算**，而不是存一份"上次算出来的" —— 顶栏那个数字必须
   * 始终等于"下一次请求会占用多少"。存字段就会出现"改了设置后顶栏还写着
   * 已裁剪"这种自相矛盾的显示（上一版就是这么错的）。
   */
  function status(): ChatSnapshot['context'] {
    const conversation = deps.activeConversation();
    const config = resolveConfig(deps.settings.get(), conversation);

    const summary = activeSummaryOf(conversation);
    const tree = deps.activeTree();
    const usedTokens = estimateContextUsage({
      path: activePathOf(cachedTreeIndex(tree.nodes), tree.activeRootChildId),
      summaryTokens: summary?.tokens ?? 0,
      systemPrompt: config.systemPrompt,
    });
    const budget = config.contextBudget;

    return {
      usedTokens,
      budget,
      ratio: budget > 0 ? usedTokens / budget : 0,
      summaryCount: summariesOf(conversation).length,
      summaryTokens: summary?.tokens ?? 0,
      lastCompressedAt: summary?.createdAt ?? null,
      // 超限就是"必须先压缩"：这条闸门不看 compression 设置 ——
      // 关掉自动压缩不等于可以带着超标的上下文硬发（那只会换来一个上游 400）
      blocked: budget > 0 && usedTokens >= budget,
    };
  }

  /**
   * 是否该自动压缩
   *
   * `used < budget` 这个条件是刻意的：已经超限时不再自动压，而是走闸门拦住，
   * 让用户自己决定。理由是这样最不容易让人困惑 —— "我明明关着自动压缩，
   * 怎么它还自己改了我的上下文"这句话，一旦出现就很难解释了。
   */
  function shouldAutoCompress(config: ResolvedConfig, used: number): boolean {
    if (config.compression !== 'auto' || config.contextBudget <= 0) return false;
    if (used >= config.contextBudget) return false;
    return used >= config.contextBudget * config.compressAt;
  }

  /**
   * 发送前的上下文闸门
   *
   * 两件事，顺序不能反：
   *  1. 到触发线且允许自动压缩 → 先压下再说（用户看不到停顿之外的东西）；
   *  2. 压完（或没压）仍然超上限 → **拦住这次发送**，并给出可执行的下一步。
   *
   * 为什么拦住而不是"超了就照发"：发出去确实有可能成功（模型的真实窗口
   * 通常比我们设的预算大），但那是**拿一次必然失败的重试去赌** ——
   * 用户会看到请求转很久然后报一个看不出原因的上游错误。
   * 计费、等待、困惑三样都白费，不如当场说清楚。
   *
   * 返回压缩后的最新会话与树：压缩会改节点标记与会话行，
   * 调用方拿着旧引用继续，会让这些改动在随后的提交里被覆盖掉。
   */
  async function prepare(
    incoming: string,
  ): Promise<Result<{ conversation: Conversation; tree: TreeState; config: ResolvedConfig }>> {
    if (deps.isCompressing()) {
      return err(appError('VALIDATION_ERROR', '正在压缩上下文，请稍等片刻再发'));
    }

    let conversation = deps.activeConversation();
    let config = resolveConfig(deps.settings.get(), conversation);

    const measure = (): number => {
      const tree = deps.activeTree();
      return estimateContextUsage({
        path: activePathOf(cachedTreeIndex(tree.nodes), tree.activeRootChildId),
        summaryTokens: activeSummaryOf(conversation)?.tokens ?? 0,
        systemPrompt: config.systemPrompt,
        incoming,
      });
    };

    let used = measure();

    if (shouldAutoCompress(config, used)) {
      await compress();
      conversation = deps.activeConversation();
      config = resolveConfig(deps.settings.get(), conversation);
      used = measure();
    }

    if (config.contextBudget > 0 && used >= config.contextBudget) {
      return err(
        appError(
          'UPSTREAM_CONTEXT_TOO_LONG',
          [
            `上下文已到设定上限（约 ${used} / ${config.contextBudget} token），这一条发不出去。`,
            '点顶栏右侧的上下文按钮可以压缩一次；没有可压的内容时，把「上下文长度」调大即可继续。',
          ].join('\n'),
        ),
      );
    }

    return ok({ conversation, tree: deps.activeTree(), config });
  }

  /**
   * 把较早的历史压成一段纪要
   *
   * 步骤：选段（纯函数）→ 调模型改写 → 打标记 + 存纪要。
   * **原文一字不删**：只是不再随请求发送。这一点让整个操作是可回看的，
   * 也让用户看到"被压缩"时不必担心内容丢了。
   */
  async function compress(
    options: { allowWhileStreaming?: boolean } = {},
  ): Promise<Result<ContextCompressionReport>> {
    if (deps.isCompressing()) return err(appError('VALIDATION_ERROR', '正在压缩中，请稍候'));
    if (deps.streamingId() !== null && options.allowWhileStreaming !== true) {
      return err(appError('VALIDATION_ERROR', '生成过程中不能压缩，先等它结束或点停止'));
    }

    const conversation = deps.activeConversation();
    const tree = deps.activeTree();
    const config = resolveConfig(deps.settings.get(), conversation);

    const path = activePathOf(cachedTreeIndex(tree.nodes), tree.activeRootChildId);
    const previous = activeSummaryOf(conversation);
    const alreadySummarized = new Set(
      path.filter((node) => node.contextFlags?.summarized === true).map((node) => node.id),
    );

    const plan = planCompression({
      path,
      keepRecentTurns: config.keepRecentTurns,
      alreadySummarized,
    });

    if (!plan) {
      return err(
        appError(
          'VALIDATION_ERROR',
          '没有可压缩的历史了：最近的内容会原样保留，更早的已经压过。把「上下文长度」调大，或者开一个新会话吧。',
        ),
      );
    }

    deps.setCompressing(true);
    deps.emit();

    try {
      const result = await deps.provider.complete({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        envVarName: config.envVarName,
        requestTimeoutMs: config.requestTimeoutMs,
        extraBodyJson: config.extraBody,
        model: config.model,
        messages: buildCompressionMessages({
          transcript: describeNodes(plan.nodes),
          /*
           * 旧纪要要一起喂进去
           *
           * 不然这次压缩会把它覆盖掉，而它装着更早的历史 ——
           * 表现是"压第二次之后，前十几轮的事全没了"。
           */
          previousSummary: previous?.text ?? null,
          targetTokens: plan.targetTokens,
        }),
      });

      if (!result.ok) return result;

      const summary: ContextSummary = {
        id: `sum-${nanoid(10)}`,
        modelRef: config.model,
        text: result.data.text,
        tokens: estimateTokens(result.data.text),
        coveredCount: plan.coveredCount,
        createdAt: Date.now(),
      };

      const coveredIds = new Set(plan.nodes.map((node) => node.id));
      const nextTree: TreeState = {
        ...tree,
        nodes: tree.nodes.map((node) =>
          coveredIds.has(node.id)
            ? {
                ...node,
                contextFlags: { ...(node.contextFlags ?? {}), summarized: true },
                updatedAt: Date.now(),
              }
            : node,
        ),
      };

      const committed = await deps.commit(conversation.id, nextTree, {
        extensions: withSummary(conversation, summary),
      });
      if (!committed.ok) return committed;

      deps.setNote(
        `已把 ${plan.coveredCount} 条较早的消息压成纪要（约 ${plan.coveredTokens} → ${summary.tokens} token）`,
      );
      deps.emit();

      return ok({
        coveredCount: plan.coveredCount,
        beforeTokens: plan.coveredTokens,
        afterTokens: summary.tokens,
      });
    } finally {
      deps.setCompressing(false);
      deps.emit();
    }
  }

  return { status, shouldAutoCompress, prepare, compress };
}
