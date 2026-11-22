import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LockCard, LockForm, type LockProps } from './lock-card';

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * A sequence: the items in the server's order for this team, put in order by drag
 * (pointer, touch, keyboard) or by the up and down buttons; the ids sent as shown.
 */
export function SequenceLock({ lock, block, submit }: LockProps) {
  const { t } = useTranslation('escape');
  const items = lock.items ?? [];
  const ids = items.map((i) => i.id);
  const [order, setOrder] = useState(ids);
  // Other items (a new stage, a new game): their order starts again from the server's.
  const shown = sameSet(order, ids) ? order : ids;
  if (shown !== order) setOrder(shown);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = (from: number, to: number) => {
    if (to < 0 || to >= shown.length) return;
    setOrder(arrayMove(shown, from, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(shown.indexOf(String(active.id)), shown.indexOf(String(over.id)));
  };
  return (
    <LockCard lock={lock}>
      <LockForm
        lock={lock}
        block={block}
        ready={shown.length > 0}
        send={() => submit(lock.id, shown)}
      >
        {(disabled) => (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown} strategy={verticalListSortingStrategy}>
              <ul
                tabIndex={-1}
                aria-label={lock.label}
                className="flex flex-col gap-2 focus-visible:outline-none"
              >
                {shown.map((id, i) => {
                  const item = items.find((x) => x.id === id);
                  if (!item) return null;
                  return (
                    <SequenceRow
                      key={id}
                      id={id}
                      label={item.label}
                      index={i}
                      last={i === shown.length - 1}
                      disabled={disabled}
                      onMove={(dir) => move(i, i + dir)}
                      t={t}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </LockForm>
    </LockCard>
  );
}

function SequenceRow({
  id,
  label,
  index,
  last,
  disabled,
  onMove,
  t,
}: {
  id: string;
  label: string;
  index: number;
  last: boolean;
  disabled: boolean;
  onMove: (dir: -1 | 1) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'bg-background flex items-center gap-1 rounded-lg border py-1 pr-1 select-none',
        isDragging && 'relative z-10 shadow-lg ring-2 ring-primary/40',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={t('lock.dragItem', { item: label })}
        disabled={disabled}
        className="text-muted-foreground focus-visible:ring-ring flex min-h-12 min-w-12 cursor-grab touch-none items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing disabled:opacity-50"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-5" />
      </button>
      <span className="text-muted-foreground w-6 tabular-nums">{index + 1}.</span>
      <span className="min-w-0 flex-1">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-12 min-w-12 aria-disabled:cursor-default aria-disabled:opacity-50"
        aria-label={t('lock.moveUp', { item: label })}
        disabled={disabled}
        aria-disabled={index === 0 || undefined}
        onClick={() => index > 0 && onMove(-1)}
      >
        <ArrowUp className="size-5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-12 min-w-12 aria-disabled:cursor-default aria-disabled:opacity-50"
        aria-label={t('lock.moveDown', { item: label })}
        disabled={disabled}
        aria-disabled={last || undefined}
        onClick={() => !last && onMove(1)}
      >
        <ArrowDown className="size-5" />
      </Button>
    </li>
  );
}
