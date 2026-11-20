'use client';
import { Menu as Base } from '@base-ui/react/menu';
import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Under the label: why it cannot be pressed, or what it will do. */
  note?: string;
  /** The one of a few ways to see something that is showing now, ticked. */
  on?: boolean;
}

/** Who someone is, as the initial of their address. Never a picture: the page loads nothing from another origin. */
export function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-(--control) items-center justify-center rounded-(--corner) bg-(--fill) font-heading text-sm font-bold uppercase">
      {name.trim().charAt(0) || '?'}
    </span>
  );
}

/**
 * A few things to do, kept behind one button until wanted. `trigger` is what the button shows (an
 * `Avatar`, an icon) and `label` names it; `heading` says what the menu is about. Opens under the
 * button, lined up with its `align` edge, and stays inside the screen. Choosing one value from several is a `Select`, not a menu.
 */
export function Menu({
  label,
  trigger,
  heading,
  items,
  align = 'start',
}: {
  label: string;
  trigger: ReactNode;
  heading?: ReactNode;
  items: readonly MenuItem[];
  align?: 'start' | 'end';
}) {
  return (
    <Base.Root>
      <Base.Trigger
        aria-label={label}
        className="press inline-flex shrink-0 cursor-pointer items-center justify-center hover:bg-(--fill) data-popup-open:bg-(--fill-strong)"
      >
        {trigger}
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={6} align={align} className="z-50">
          <Base.Popup className="sheet max-w-[calc(100vw-2rem)] min-w-52 bg-popover p-1 text-sm text-foreground outline-none">
            {heading ? <div className="row mb-1 px-2 pt-1.5 pb-2.5">{heading}</div> : null}
            {items.map((item) => (
              <Base.Item
                key={item.label}
                disabled={item.disabled ?? false}
                onClick={item.onSelect}
                {...(item.on === undefined ? {} : { role: 'menuitemradio', 'aria-checked': item.on })}
                className="flex cursor-pointer data-disabled:cursor-default flex-col justify-center px-2 py-1.5 outline-none select-none data-disabled:text-muted-foreground data-highlighted:bg-(--fill-strong) pointer-coarse:min-h-11"
              >
                <span className="flex items-center gap-3 font-medium">
                  <span className="flex-1">{item.label}</span>
                  {item.on ? <CheckIcon aria-hidden className="size-3.5" /> : null}
                </span>
                {item.note ? <span className="text-muted-foreground">{item.note}</span> : null}
              </Base.Item>
            ))}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
