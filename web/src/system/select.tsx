'use client';
import { Select as Base } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TRIGGER =
  'press inline-flex cursor-pointer items-center select-none disabled:pointer-events-none disabled:opacity-45 data-disabled:pointer-events-none data-disabled:opacity-45 border border-transparent bg-(--fill) hover:bg-(--fill-strong) data-popup-open:bg-(--fill-strong)';
const CONTROL = 'h-(--control) max-w-full justify-between gap-1.5 pr-2 pl-3 text-sm whitespace-nowrap';

/**
 * One choice from a short list. `options` are `[value, label]` pairs; `label` names the control for screen readers.
 * A `null` between two draws a rule, setting apart what is not one of the rest (Leave in inbox from the labels).
 * `icons` gives a choice its icon, before its label in the list and once chosen (an action's). `wide` runs the width
 * of what holds it. `face` is drawn in the trigger in place of the value and chevron, where a control's width does not
 * fit (the rail); the choices still say themselves in full.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  icons,
  wide,
  face,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string] | null)[];
  onChange: (value: T) => void;
  disabled?: boolean;
  icons?: Partial<Record<T, ReactNode>>;
  wide?: boolean;
  face?: ReactNode;
}) {
  const items = options.flatMap((option) => (option ? [{ value: option[0], label: option[1] }] : []));
  return (
    <Base.Root items={items} value={value} disabled={disabled ?? false} onValueChange={(next) => next !== null && onChange(next)}>
      <Base.Trigger aria-label={label} className={cn(TRIGGER, face ? 'flex-col justify-center' : CONTROL, wide && 'w-full')}>
        {face ?? (
          <>
            {/* Down a pixel, as a button's words sit: Karla centred on its box reads high. */}
            <span className="relative top-px flex min-w-0 items-center gap-2">
              {icons?.[value] ?? null}
              <span className="truncate">
                <Base.Value />
              </span>
            </span>
            <Base.Icon render={<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />} />
          </>
        )}
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={4} align="start" alignItemWithTrigger={false} className="z-50">
          <Base.Popup className="sheet max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto bg-popover p-1 text-sm outline-none">
            <Base.List>
              {options.map((option, index) =>
                option === null ? (
                  index > 0 && index < options.length - 1 ? (
                    <Base.Separator key={`rule ${index}`} className="my-1 border-t border-(--rule)" />
                  ) : null
                ) : (
                  <Base.Item
                    key={option[0]}
                    value={option[0]}
                    className="relative flex cursor-pointer data-disabled:cursor-default items-center py-1.5 pr-8 pl-2 whitespace-nowrap outline-none select-none data-highlighted:bg-(--fill-strong) pointer-coarse:min-h-11"
                  >
                    {icons?.[option[0]] ? <span className="mr-2 flex">{icons[option[0]]}</span> : null}
                    <Base.ItemText>{option[1]}</Base.ItemText>
                    <Base.ItemIndicator className="absolute right-2 flex items-center">
                      <CheckIcon className="size-3.5" />
                    </Base.ItemIndicator>
                  </Base.Item>
                ),
              )}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
