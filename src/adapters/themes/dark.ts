import type { Theme } from '@ports/Theme';
import { asThemeId } from '@shared/ids';
import { baseTokens, palette } from './primitives';

/** 黑夜主题：深蓝灰底 + 提亮后的蓝色强调色（保证对比度仍达 AA） */
export const darkTheme: Theme = {
  id: asThemeId('braid.dark'),
  name: '黑夜',
  version: '0.1.0',
  colorScheme: 'dark',
  meta: { author: 'Braid', description: '默认黑夜主题' },
  tokens: {
    ...baseTokens,
    primitive: palette,
    semantic: {
      bg: {
        canvas: '#0B1220',
        surface: '#111A2B',
        raised: '#18233A',
        sunken: '#080E1A',
        overlay: 'rgba(2, 6, 23, 0.62)',
      },
      text: {
        primary: '#E6EDF7',
        secondary: '#9FB0C9',
        tertiary: '#6B7C96',
        disabled: '#3E4C63',
        inverse: '#0B1220',
        link: '#7CB3FF',
      },
      border: {
        subtle: '#162033',
        default: '#1F2C44',
        strong: '#33445F',
        focus: '#5B9DFF',
      },
      accent: {
        default: '#4A8CFF',
        hover: '#6BA1FF',
        active: '#8CB8FF',
        subtle: '#132444',
        onAccent: '#08101F',
      },
      status: {
        info: '#4A8CFF',
        success: '#4ADE80',
        warning: '#FBBF24',
        danger: '#F87171',
        onStatus: '#08101F',
      },
      role: {
        userBubble: '#2A5BC7',
        userText: '#F2F7FF',
        assistantBubble: '#18233A',
        assistantText: '#E6EDF7',
        systemBubble: '#3A2E12',
        systemText: '#FCD98A',
        toolBubble: '#14213D',
        toolText: '#A8C7FF',
      },
      diff: {
        add: 'rgba(74, 222, 128, 0.14)',
        addText: '#86EFAC',
        del: 'rgba(248, 113, 113, 0.14)',
        delText: '#FCA5A5',
        gutter: '#0F1A2C',
      },
      selection: 'rgba(74, 140, 255, 0.30)',
      caret: '#7CB3FF',
      scrollbarThumb: '#2A3A55',
      scrollbarTrack: 'transparent',
    },
  },
};
