import type { StreamPhase } from '@ports/ChatApi';

/**
 * 过程面板（思考过程 / 文件工具）该不该**自动**展开
 *
 * 【为什么单独成模块】这套规则被改坏过两次，而根因都是同一个：判据问的是
 * "**有没有东西在跑**"，而不是"**现在处于哪个阶段**" ——
 *  - 思考框：`streaming && 正文为空`，于是续写的第二轮又开始思考时，正文早就不为空了，
 *    框不会展开（真实反馈："中途再开始思考不会自动展开"）；
 *  - 工具框：只要有调用还没结果就展开、结果一到就折叠 —— 而写一个文件只要几十毫秒，
 *    于是一开一合根本看不见（真实反馈："没看见折叠框自动展开"）。
 *
 * 抽成纯函数是为了能用用例把规则钉住：这三条都是"看起来只是几个布尔判断"、
 * 却各自对应一个用户能感觉到的毛病。
 *
 * 【规则】
 *  - 两个「默认展开」设置是**常开**语义：开了就一直展开，上面那些阶段规则都不再管它
 *    （用户明确说了"我就是要一直看着"）。它们彼此独立，谁也不带开另一个；
 *  - 不在生成中（阶段为 `null` / 消息已结束）→ 一律不自动展开：历史消息保持默认收起，
 *    用户点开的就是他点的（这是「只管正在生成的那条」的落点）；
 *  - 跟随总开关关掉 → 同样不自动展开，开与合只由用户决定；
 *  - 思考阶段 → 只展开思考框；
 *  - 工具阶段 → 只展开工具框。**工具执行完、模型还没开口的那一段仍算工具阶段** ——
 *    否则那个框就会一闪而过，"即将动你的文件"根本没机会被看到；
 *  - 正文阶段 → 两个都不展开：正文出现就是把版面让给它的信号。
 */
export function autoPanelOpen(input: {
  /** 当前阶段；`null` = 没有在生成 */
  phase: StreamPhase | null;
  /** 「思考过程默认展开」：开了就一直展开，与阶段无关 */
  reasoningAlwaysOpen: boolean;
  /** 「工具使用过程默认展开」：同上，两个面板是对称的 */
  toolsAlwaysOpen: boolean;
  /** 「跟随过程自动展开」总开关 */
  follow: boolean;
}): { reasoning: boolean; tools: boolean } {
  const { phase, follow, reasoningAlwaysOpen, toolsAlwaysOpen } = input;

  return {
    reasoning: reasoningAlwaysOpen || (follow && phase === 'reasoning'),
    tools: toolsAlwaysOpen || (follow && phase === 'tool'),
  };
}
