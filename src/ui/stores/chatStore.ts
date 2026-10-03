import { create } from 'zustand';
import type { Conversation } from '@domain/entities/conversation';
import { createEmptyConversation } from '@domain/entities/conversation';
import type { RolePreset } from '@domain/entities/rolePreset';
import type { ChatApi, ChatSnapshot, EditSubmitMode } from '@ports/ChatApi';
import type { MessageSearchHit } from '@ports/repositories/MessageStore';
import { asConversationId, type ConversationId, type MessageId } from '@shared/ids';

/**
 * 会话与消息树的「界面镜像」
 *
 * 与 settingsStore / rolesStore 同一套纪律：**这里没有任何业务规则**。
 * 会话列表、消息树分支、级联删除、持久化全部在 `ChatService`（应用层），
 * store 只做两件事：订阅快照、把界面操作转发给服务。
 *
 * 所以界面组件里看到的所有 `conversations` / `tree` 都只是**只读投影**。
 */
interface ChatState extends ChatSnapshot {
  loaded: boolean;
  error: string | null;
  bind: (api: ChatApi) => void;
  clearError: () => void;

  /** 新建会话；传角色则把角色实例快照进去（角色面板的「开始对话」） */
  startConversationWithRole: (role: RolePreset | null) => Promise<void>;
  selectConversation: (id: ConversationId) => void;
  deleteConversation: (id: ConversationId) => void;
  renameConversation: (id: ConversationId, title: string) => void;
  /** 手动排序：传当前可见顺序的 id 列表 */
  reorderConversations: (orderedIds: ConversationId[]) => void;

  /** 修改当前会话（会话设置面板与输入区档位都用它） */
  patchConversation: (patch: Partial<Conversation>) => void;
  resyncRoleInstance: (role: RolePreset) => void;

  /** 发送；返回 `false` = 没被接受（草稿要留在输入框里，见实现处的说明） */
  send: (text: string) => Promise<boolean>;
  /** 中止当前生成（同步操作，不走 Result） */
  stop: () => void;
  editMessage: (id: MessageId, text: string, mode: EditSubmitMode) => void;
  deleteMessage: (id: MessageId) => void;
  regenerate: (id: MessageId) => void;
  /** 接着往下写（「每轮询问」档位下那个按钮） */
  continueWriting: (id: MessageId) => void;
  selectVariant: (id: MessageId, delta: number) => void;
  /** 手动压缩上下文（顶栏上下文菜单里的按钮） */
  compressContext: () => void;

  /** 正文搜索的命中；标题搜索是纯本地的，不经过这里 */
  searchHits: MessageSearchHit[];
  /**
   * 产生这批命中的**查询词**
   *
   * 高亮要用的是"这批命中对应的那个词"，而不是输入框里的实时值 ——
   * 改了词但结果还没回来时，两者并不一致，用后者就会高亮出不该有的东西。
   */
  searchQuery: string;
  searchMessages: (query: string) => void;
  clearSearchHits: () => void;
  /**
   * 当前停在**第几处**命中（`searchHits` 的下标）
   *
   * `-1` 表示"这次搜索还没定位过任何一处" —— 与"停在第 0 处"是两回事：
   * 前者应该显示"共 N 处命中"，后者显示"第 1/N 处"。
   * 有它才谈得上"下一处 / 上一处"。
   */
  searchCursor: number;
  setSearchCursor: (index: number) => void;

  /**
   * 当前**聚焦**的那一处命中（滚动过去 + 强调高亮 + 必要时展开思考）
   *
   * 放在 store 而不是组件局部状态：**点它的是侧栏，执行它的是消息区**，
   * 两者之间隔着好几层布局，没有共同的父组件可以传 props。
   */
  locate: { messageId: MessageId; occurrence: number; reasoningOnly: boolean } | null;
  locateMessage: (hit: MessageSearchHit) => void;
}

let service: ChatApi | null = null;
let bound = false;

export const useChatStore = create<ChatState>((set) => {
  /** 统一处理"转发给服务 + 收集错误"，避免每个 action 重复写一遍 */
  const run = (task: (api: ChatApi) => Promise<{ ok: boolean; error?: { message: string } }>) => {
    if (!service) return;
    void task(service).then((result) => {
      if (!result.ok && result.error) {
        set({ error: result.error.message });
        return;
      }
      /*
       * 成功时清掉上一次的错误（同 settingsStore：错误代表"当前状态"，不是历史）
       *
       * 用"返回同一个 state 就不通知"的写法：这条路径会被打字这类高频操作反复走到
       * （改标题每敲一键就是一次 `patchConversation`），无条件 `set` 会让每个订阅者
       * 每秒重渲染好几次。
       */
      set((state) => (state.error === null ? state : { error: null }));
    });
  };

  return {
    conversations: [],
    activeId: null,
    // 装载前先给一个空壳，组件不必写 null 判断；服务很快就会用真实数据覆盖它。
    // 用领域工厂而不是手写字面量：以后给 Conversation 加字段，这里自动跟上。
    conversation: createEmptyConversation(asConversationId('pending'), 0),
    tree: { nodes: [], activeRootChildId: null },
    streamingMessageId: null,
    streamPhase: null,
    continuableMessageId: null,
    contextNote: null,
    // 装载前当作"还没有落库问题"；服务会用真实状态覆盖它
    persistenceError: null,
    // 装载前给一个"什么都还没算"的壳，组件不必写 null 判断
    context: {
      usedTokens: 0,
      budget: 0,
      ratio: 0,
      summaryCount: 0,
      summaryTokens: 0,
      lastCompressedAt: null,
      blocked: false,
    },
    compressing: false,
    loaded: false,
    error: null,

    bind: (api) => {
      if (bound) return;
      bound = true;
      service = api;

      api.subscribe((snapshot) => set({ ...snapshot, loaded: true }));

      // 同步拉一次当前值：装载由组合根发起，可能早于界面挂载，那时订阅会错过 emit
      const snapshot = api.snapshot();
      set({ ...snapshot, loaded: api.isLoaded() });
    },

    clearError: () => set({ error: null }),

    compressContext: () => run((api) => api.compressContext()),

    /** 正文搜索的命中；标题搜索是纯本地的，不经过这里 */
    searchHits: [] as MessageSearchHit[],
    searchQuery: '',
    searchMessages: (query) => {
      const trimmed = query.trim();
      /*
       * 清空搜索框 = **取消搜索**
       *
       * 命中、指针、聚焦目标一起归零。正文里的高亮是由"有命中 + 有聚焦目标"
       * 推导出来的，所以它们一没，高亮自然就没了 —— 不需要谁去手动擦。
       * 空词也不必为"什么都没搜"去打一次数据库。
       */
      if (trimmed.length === 0) {
        set({ searchHits: [], searchCursor: -1, searchQuery: '', locate: null });
        return;
      }
      if (!service) return;
      void service.searchMessages(trimmed).then((result) => {
        /*
         * 新一批结果：上一轮的下标与聚焦目标跟它毫无对应关系，一起清掉。
         * 否则高亮会停在上一次的命中上，看起来像"搜了没反应"。
         */
        if (result.ok) {
          set({ searchHits: result.data, searchCursor: -1, searchQuery: trimmed, locate: null });
        }
      });
    },
    clearSearchHits: () =>
      set({ searchHits: [], searchCursor: -1, searchQuery: '', locate: null }),

    searchCursor: -1,
    setSearchCursor: (index) => set({ searchCursor: index }),

    locate: null as ChatState['locate'],
    locateMessage: (hit) =>
      set({
        locate: {
          messageId: hit.messageId,
          occurrence: hit.occurrence,
          reasoningOnly: hit.reasoningOnly,
        },
      }),

    startConversationWithRole: async (role) => {
      if (!service) return;
      const result = await service.create(role);
      if (!result.ok) set({ error: result.error.message });
    },

    selectConversation: (id) => run((api) => api.select(id)),
    deleteConversation: (id) => run((api) => api.remove(id)),
    renameConversation: (id, title) => run((api) => api.rename(id, title)),
    reorderConversations: (orderedIds) => run((api) => api.reorderConversations(orderedIds)),

    patchConversation: (patch) => run((api) => api.updateActive(patch)),
    resyncRoleInstance: (role) => run((api) => api.resyncRole(role)),

    /*
     * 发送要**把成败交回给调用方**
     *
     * 早先它和别的命令一样走 `run`（返回 void）：被闸门拦住时（上下文超预算、
     * 会话已不存在……）界面无从知道，而输入区在那之后**无条件清空了草稿** ——
     * 用户打的字既没进会话、也从输入框消失，还得自己想"刚才发生了什么"。
     * 这里返回布尔，让输入区只在真的被接受时才清空。
     */
    send: async (text) => {
      if (!service) return false;
      const result = await service.send(text);
      if (!result.ok) {
        set({ error: result.error.message });
        return false;
      }
      set({ error: null });
      return true;
    },
    stop: () => service?.stop(),
    editMessage: (id, text, mode) => run((api) => api.editMessage(id, text, mode)),
    deleteMessage: (id) => run((api) => api.deleteMessage(id)),
    regenerate: (id) => run((api) => api.regenerate(id)),
    continueWriting: (id) => run((api) => api.continueWriting(id)),
    selectVariant: (id, delta) => run((api) => api.selectVariant(id, delta)),
  };
});
