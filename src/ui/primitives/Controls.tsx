import clsx from 'clsx';
import { Fragment, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { HelpTip, Tooltip, useInsideTooltip } from './Tooltip';
import styles from './Controls.module.css';

/* ────────────────────────────── 开关 ────────────────────────────── */

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={styles.switch}
      data-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchKnob} />
    </button>
  );
}

/* ────────────────────────────── 滑块 ────────────────────────────── */

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => String(v),
  width = 200,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  width?: number;
}) {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className={styles.sliderRow}>
      <input
        type="range"
        className={styles.slider}
        style={{ width, ['--fill' as string]: `${percent}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      />
      <span className={styles.sliderValue}>{format(value)}</span>
    </div>
  );
}

/* ────────────────────────────── 数字输入 ────────────────────────────── */

export function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  width = 120,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  suffix?: string;
  width?: number;
}) {
  /*
   * "正在输入的内容"与"已经生效的值"分开
   *
   * 早先是把输入框的值 `Number()` 之后直接传出去，于是有两个真实的坑：
   *  1. **清空输入框 → `Number('') === 0`** —— 把「上下文长度」（下限 4096）、
   *     「单次最大输出」（下限 256）、「保留最近原文」（下限 1）这类有下限的设置
   *     写成 0，随后上下文预算与请求参数就按 0 算；
   *  2. 超出上下限的数字没有任何钳制。
   *
   * 而边打边钳同样折磨人（想输 4096，第一个 "4" 就会被抬成下限）。所以规则是：
   * **打字期间只让"已经在范围内的值"立刻生效，离开输入框时再把整段钳进范围**。
   * 清空或非数字则回到原值 —— 不猜一个数字出来。
   */
  const [draft, setDraft] = useState(String(value));

  // 外部改了值（切换档案、恢复默认）就同步过来；打字过程中这里不会触发
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = clampNumber(parsed, min, max);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  /**
   * 用微调箭头走一步
   *
   * 与键盘上/下键同一套语义：**立刻生效**（这里没有"打了一半"的中间态），
   * 但同样要钳进范围 —— 到边界时按钮会置灰，而不是让值越界再被上游拒。
   */
  const nudge = (direction: 1 | -1) => {
    const next = clampNumber(value + direction * step, min, max);
    if (next === value) return;
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className={clsx(styles.inputWrap, styles.numberWrap)} style={{ width }}>
      <input
        type="number"
        className={clsx(styles.input, styles.numberInput)}
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const parsed = Number(raw);
          if (raw.trim() === '' || !Number.isFinite(parsed)) return;
          if (parsed !== clampNumber(parsed, min, max)) return; // 越界：等失焦再钳
          if (parsed !== value) onChange(parsed);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        }}
      />
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      {/*
        自绘的上下微调箭头

        原生那两个（`::-webkit-inner-spin-button`）不跟主题，还会与单位文字抢位置 ——
        这正是"箭头样式没适配"的来源。改用自绘的：颜色走 token、位置固定、悬停才显形。
      */}
      <span className={styles.stepper}>
        <button
          type="button"
          className={clsx(styles.stepBtn, styles.stepUp)}
          aria-label="增加"
          disabled={max !== undefined && value >= max}
          onClick={() => nudge(1)}
        />
        <button
          type="button"
          className={clsx(styles.stepBtn, styles.stepDown)}
          aria-label="减少"
          disabled={min !== undefined && value <= min}
          onClick={() => nudge(-1)}
        />
      </span>
    </div>
  );
}

/**
 * 把数字钳进 `[min, max]`
 *
 * 单独提出来是为了能被用例钉住：这里出错的后果不是"界面不好看"，
 * 而是把上下文长度、输出上限这类**会算坏请求**的值写成越界的数。
 */
export function clampNumber(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

/* ────────────────────────────── 文本输入 ────────────────────────────── */

/**
 * 单行文本框
 *
 * `autoWidth`：宽度跟着内容走，但有上下限。
 * 实现在于"用一个**完全相同的类**渲染一个隐藏 span 去量宽" ——
 * 共用 `.input` 意味着字体、内边距、边框天然一致，量出来的 `offsetWidth`
 * 可以直接当输入框宽度用，不需要任何经验系数。
 * 按字符数估算会在中英混排、等宽字体下明显偏差，所以不那么做。
 *
 * 超过 `maxWidth` 后不再增长：这时浏览器会横向滚动，
 * 且**未聚焦时自动回到最左端**（浏览器行为），正好是"显示开头、右侧截断"。
 */
export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono,
  password,
  full,
  width,
  autoWidth,
  maxWidth = 340,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
  password?: boolean;
  full?: boolean;
  width?: number;
  autoWidth?: boolean;
  maxWidth?: number;
}) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    if (!autoWidth) return;
    setMeasured(measureRef.current?.offsetWidth ?? 0);
  }, [autoWidth, value, placeholder, mono]);

  const style = autoWidth
    ? { width: Math.min(maxWidth, Math.max(72, measured + 2)) }
    : width !== undefined
      ? { width }
      : undefined;

  const className = clsx(
    styles.input,
    mono && styles.inputMono,
    password && styles.inputPassword,
    full && styles.inputFull,
  );

  const input = (
    <input
      type={type}
      className={className}
      style={style}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
    />
  );

  if (!autoWidth) return input;

  return (
    <span className={styles.autoWrap}>
      {/* 与真实输入框共用 .input 类 → 字体与内边距完全一致，量出的宽度可直接用 */}
      <span ref={measureRef} className={clsx(className, styles.measure)} aria-hidden="true">
        {value || placeholder || ''}
      </span>
      {input}
    </span>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      className={clsx(styles.textarea, mono && styles.inputMono)}
      value={value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* 下拉选择见 ./Dropdown.tsx —— 自绘实现，不用原生 <select> */

/* ────────────────────────────── 分段选择 ────────────────────────────── */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group">
      {options.map((option) => {
        const button = (
          <button
            type="button"
            className={styles.segmentBtn}
            data-active={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );

        // 有补充说明才挂浮层（`Tooltip` 对原生标签是直接挂事件，不会插节点、不动布局）
        return option.title ? (
          <Tooltip key={option.value} label={option.title}>
            {button}
          </Tooltip>
        ) : (
          <Fragment key={option.value}>{button}</Fragment>
        );
      })}
    </div>
  );
}

/* ────────────────────────────── 图标按钮 ────────────────────────────── */

export function IconButton({
  label,
  onClick,
  active,
  size = 30,
  className,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  size?: number;
  className?: string;
  /**
   * 禁用
   *
   * 【为什么这个按钮也需要它】
   * 有些动作是"正在进行、再点一次会出事"的（导出全部数据、导入备份）——
   * 光把 label 换成"正在导出…"不够：按钮看起来还能按，用户就会一直按，
   * 而那种"按了没反应"的感觉和坏了没区别。真正禁用（灰掉 + 不响应）才说得清。
   */
  disabled?: boolean;
  children: ReactNode;
}) {
  const insideTooltip = useInsideTooltip();

  /*
   * 提示**只有一处**，而且永远是应用自己那一个
   *
   * 早先这里是 `title={label}`（浏览器原生浮层）：调用方再用 `<Tooltip>` 包一层，
   * 鼠标一停就会**两个面板同时出现**，还是两套字（原生那个是 `label`，
   * 应用那个是外层给的说明）。反过来，没被包住的（收起侧栏、导出全部、会话设置…）
   * 就只有那个慢半拍、不跟主题的原生浮层 —— 同一排按钮两种提示，看起来像没做完。
   *
   * 现在：外面已经有应用的提示 → 这里什么都不加；没有 → 自己补一个。
   * 原生 `title` 一律不写，免得又冒出第二个面板。
   */
  const button = (
    <button
      type="button"
      className={clsx(styles.iconButton, className)}
      data-active={active}
      style={{ width: size, height: size }}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );

  if (insideTooltip) return button;
  return <Tooltip label={label}>{button}</Tooltip>;
}

/* ────────────────────────────── 设置行 ────────────────────────────── */

/**
 * 统一的设置行布局：左侧「标签 + 说明图标」，右侧控件。
 *
 * 说明文字全部收进 HelpTip，正文只留标签 —— 这样设置页可以塞进更多项且不显臃肿。
 */
export function SettingRow({
  label,
  help,
  hint,
  stacked,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** 常驻在标签下方的小字（仅用于必须一直可见的信息，如"实际生效值"） */
  hint?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.row} data-stacked={stacked}>
      <div className={styles.rowLabel}>
        <span className={styles.rowLabelText}>{label}</span>
        {help ? <HelpTip text={help} /> : null}
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

/** 设置分组标题 */
export function SettingGroup({
  title,
  help,
  children,
}: {
  title: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>
        {title}
        {help ? <HelpTip text={help} /> : null}
      </h3>
      <div className={styles.groupBody}>{children}</div>
    </section>
  );
}
