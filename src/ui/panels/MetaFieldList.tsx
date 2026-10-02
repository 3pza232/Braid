import { useState } from 'react';
import type { MetaFieldSettings } from '@domain/value-objects/appSettings';
import { META_FIELD_LABELS, reorderMetaFields } from '@domain/value-objects/appSettings';
import { DragHandle, Switch } from '@ui/primitives';
import styles from './MetaFieldList.module.css';

/**
 * 消息信息栏的字段列表：可拖动排序 + 逐个开关
 *
 * 拖拽状态（正在拖谁、悬停在谁上面）**留在本组件内部**，
 * 因为它只影响这块的渲染反馈；写进设置里反而会让"落盘的数据"混入临时视图状态。
 *
 * 排序算法在 `domain/value-objects/appSettings.ts` 的 `reorderMetaFields` ——
 * 组件只负责收集"从哪拖到哪"，不自己算数组。
 */
export function MetaFieldList({
  fields,
  onChange,
}: {
  fields: MetaFieldSettings[];
  onChange: (next: MetaFieldSettings[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const stopDrag = () => {
    setDragging(null);
    setOver(null);
  };

  return (
    <div className={styles.list}>
      {fields.map((field, index) => (
        <div
          key={field.id}
          className={styles.row}
          data-dragging={dragging === index}
          data-over={dragging !== null && over === index && dragging !== index}
          onDragOver={(event) => {
            // 没有正在拖动时不要在悬停时高亮，否则鼠标划过整列都会闪
            if (dragging === null) return;
            event.preventDefault();
            setOver(index);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging !== null) onChange(reorderMetaFields(fields, dragging, index));
            stopDrag();
          }}
        >
          <DragHandle
            role="button"
            tabIndex={0}
            draggable
            title="按住拖动调整顺序"
            aria-label={`拖动调整「${META_FIELD_LABELS[field.id]}」的顺序`}
            onDragStart={(event) => {
              setDragging(index);
              event.dataTransfer.effectAllowed = 'move';
              // 部分浏览器不设置数据就完全不触发 drag 事件，这里是必须的
              event.dataTransfer.setData('text/plain', field.id);
            }}
            onDragEnd={stopDrag}
            onKeyDown={(event) => {
              // 键盘也能排序：拖拽对只用键盘的人不可用，而这是纯功能而非装饰
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                onChange(reorderMetaFields(fields, index, index - 1));
              }
              if (event.key === 'ArrowDown' && index < fields.length - 1) {
                event.preventDefault();
                onChange(reorderMetaFields(fields, index, index + 1));
              }
            }}
          />

          <span className={styles.label}>{META_FIELD_LABELS[field.id]}</span>

          <Switch
            label={META_FIELD_LABELS[field.id]}
            checked={field.enabled}
            onChange={(enabled) =>
              onChange(fields.map((item) => (item.id === field.id ? { ...item, enabled } : item)))
            }
          />
        </div>
      ))}
    </div>
  );
}
