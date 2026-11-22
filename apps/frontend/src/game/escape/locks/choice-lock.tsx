import { OptionColor, OptionShape, type PublicOption } from '@quiz-dock/contracts';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageChoiceGrid } from '../../image-choice';
import { mediaSrc } from '../clue-list';
import { LockCard, LockForm, type LockProps } from './lock-card';

const COLORS = Object.values(OptionColor);
const SHAPES = Object.values(OptionShape);

/**
 * A choice: any number of options toggled, their ids sent in the lock's order.
 * Pictures (every option has a safe one) show as the quiz's image grid.
 */
export function ChoiceLock({ lock, block, submit }: LockProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const options = lock.options ?? [];
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const images = options.length > 0 && options.every((o) => o.image && mediaSrc(o.image));
  const tiles: PublicOption[] = options.map((o, i) => ({
    id: o.id,
    text: o.label,
    color: COLORS[i % COLORS.length],
    shape: SHAPES[i % SHAPES.length],
    media: { url: mediaSrc(o.image ?? '') ?? '', kind: 'image', alt: o.label },
  }));
  return (
    <LockCard lock={lock}>
      <LockForm
        lock={lock}
        block={block}
        ready={picked.length > 0}
        send={() =>
          submit(
            lock.id,
            options.map((o) => o.id).filter((id) => picked.includes(id)),
          )
        }
      >
        {(disabled) =>
          images ? (
            <div tabIndex={-1} className="focus-visible:outline-none">
              <ImageChoiceGrid
                options={tiles}
                selectedIds={picked}
                onPick={toggle}
                disabled={disabled}
              />
            </div>
          ) : (
            <div tabIndex={-1} className="grid gap-2 focus-visible:outline-none">
              {options.map((o) => {
                const on = picked.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => toggle(o.id)}
                    className={cn(
                      'focus-visible:ring-ring flex min-h-12 w-full items-center gap-3 rounded-lg border px-4 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      on
                        ? 'border-primary bg-primary/10 font-medium'
                        : 'bg-background hover:bg-accent',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded border',
                        on && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {on && <Check className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">{o.label}</span>
                  </button>
                );
              })}
            </div>
          )
        }
      </LockForm>
    </LockCard>
  );
}
