import { describe, expect, it } from 'vitest';
import { decideContinuation, type ContinuationInput } from '@app/chat/continuation';

/**
 * 续写判定
 *
 * 这几条规则原先埋在 `ChatService.runStream` 的轮循环里，只有读完整段才能确认
 * "什么时候该收"。抽出来之后它的每一条都能被单独钉住 —— 它们都是**用户能看到**的后果：
 * 该收不收会让字数跑飞、该续不续会让回答半截停下、把"撞上限"说成"写完了"会让用户
 * 以为已经结束。
 */
const base: ContinuationInput = {
  active: true,
  chars: 100,
  targetChars: 800,
  softMaxChars: 2000,
  finishReason: 'stop',
  stallCount: 0,
  stallLimit: 2,
  rounds: 0,
  maxRounds: 8,
};

const decide = (patch: Partial<ContinuationInput>) => decideContinuation({ ...base, ...patch });

describe('decideContinuation', () => {
  it('没开续写：直接收（普通对话不该被续写卷进去）', () => {
    expect(decide({ active: false })).toEqual({ kind: 'stop', reason: 'not-active' });
  });

  it('写到字数下限：正常完成', () => {
    expect(decide({ chars: 800 })).toEqual({ kind: 'stop', reason: 'reached-target' });
  });

  it('到了软上限：宁可少一点也收（不为凑字数跑飞）', () => {
    expect(decide({ chars: 2000, targetChars: 5000 })).toEqual({
      kind: 'stop',
      reason: 'soft-max',
    });
  });

  it('模型这轮不是自然结束（内容过滤 / 出错）：不续写，否则越写越乱', () => {
    expect(decide({ finishReason: 'content_filter' })).toEqual({
      kind: 'stop',
      reason: 'unfinished',
    });
  });

  it('连续几轮没产出新内容：判定为在原地打转', () => {
    expect(decide({ stallCount: 2 })).toEqual({ kind: 'stop', reason: 'stalled' });
    expect(decide({ stallCount: 1 })).toEqual({ kind: 'continue' });
  });

  it('撞上轮数上限：报 round-limit（界面据此提示"还能再要"，而不是假装写完了）', () => {
    expect(decide({ rounds: 8 })).toEqual({ kind: 'stop', reason: 'round-limit' });
  });

  it('停顿与轮数上限同时成立时，报停顿（两个原因都真，但报"撞上限"会误导）', () => {
    expect(decide({ stallCount: 2, rounds: 8 })).toEqual({ kind: 'stop', reason: 'stalled' });
  });

  it('还没到任何一个边界：继续下一轮', () => {
    expect(decide({})).toEqual({ kind: 'continue' });
  });

  it('已有内容超过下限时才收；差一个字符都还要续', () => {
    expect(decide({ chars: 799 })).toEqual({ kind: 'continue' });
    expect(decide({ chars: 800 })).toEqual({ kind: 'stop', reason: 'reached-target' });
  });
});
