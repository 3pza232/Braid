import type { Theme } from '@ports/Theme';
import { asThemeId } from '@shared/ids';
import { baseTokens, palette } from './primitives';

/** 白天主题：高对比、低饱和背景、蓝色作为唯一强调色 */
export const lightTheme: Theme = {
  id: asThemeId('braid.light'),
  name: '白天',
  version: '0.1.0',
  colorScheme: 'light',
  meta: { author: 'Braid', description: '默认白天主题' },
  tokens: {
    ...baseTokens,
    primitive: palette,
    semantic: {
      bg: {
        canvas: palette.gray['0'],
        surface: palette.gray['50'],
        raised: palette.gray['0'],
        sunken: palette.gray['100'],
        overlay: 'rgba(15, 23, 42, 0.42)',
      },
      text: {
        primary: palette.gray['900'],
        secondary: palette.gray['600'],
        tertiary: palette.gray['400'],
        disabled: palette.gray['300'],
        inverse: palette.gray['0'],
        link: palette.brand['600'],
      },
      border: {
        subtle: palette.gray['100'],
        default: palette.gray['200'],
        strong: palette.gray['300'],
        focus: palette.brand['500'],
      },
      accent: {
        default: palette.brand['600'],
        hover: palette.brand['700'],
        active: '#1E40AF',
        subtle: palette.brand['50'],
        onAccent: palette.gray['0'],
      },
      status: {
        info: palette.brand['600'],
        success: palette.green['600'],
        warning: palette.amber['600'],
        danger: palette.red['600'],
        onStatus: palette.gray['0'],
      },
      role: {
        userBubble: palette.brand['600'],
        userText: palette.gray['0'],
        assistantBubble: palette.gray['100'],
        assistantText: palette.gray['900'],
        systemBubble: palette.amber['100'],
        systemText: '#78350F',
        toolBubble: palette.brand['50'],
        toolText: '#1E3A8A',
      },
      diff: {
        add: palette.green['100'],
        addText: '#166534',
        del: palette.red['100'],
        delText: '#991B1B',
        gutter: palette.gray['50'],
      },
      selection: 'rgba(59, 130, 246, 0.24)',
      caret: palette.brand['600'],
      scrollbarThumb: palette.gray['300'],
      scrollbarTrack: 'transparent',
    },
  },
};
