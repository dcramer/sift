'use client';
import { Dialog as Base } from '@base-ui/react/dialog';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { Control, ControlBar } from './controls.tsx';
import { KeyLayer } from './keys.tsx';
import { Backdrop, LayerContent, LayerFooter, useLayerOpen } from './layer.tsx';
import { AboveToasts } from './toast.tsx';

/** What had the focus as each panel opened, for its close to return there, through a panel replaced once it loaded (the composer's). */
const openers = new WeakMap<HTMLElement, HTMLElement | null>();

/**
 * One thing from a list, opened beside the list: it slides over from the right, as wide as three quarters of the
 * screen, and the list stays behind it. `onPrevious` and `onNext` step through the list without closing; leave one
 * out at either end. `narrow` for a short form. Covers the screen on a phone. Closes on Escape or a press outside.
 *
 * A Dialog is for a form or a question; a Panel is for looking at, and acting on, one item of many. A message is not
 * one: it opens in the list's place (`Reader`).
 */
export function Panel({
  open,
  onClose,
  title,
  subtitle,
  position,
  onPrevious,
  onNext,
  narrow,
  actions,
  focus,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  /** Where this is in the list, in words: "3 of 12". */
  position?: string;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  /** For one item that is a few facts and a short form (a label), rather than something to read beside the list. */
  narrow?: boolean;
  /**
   * What is done to the item itself (save, change, remove), in a footer that stays put while the rest scrolls: what changes it
   * first, then a gap, and at the right what removes it. A section's own action stays beside its heading.
   */
  actions?: ReactNode;
  /** Where the reader starts, for a panel that is written in (the composer's first empty field). Otherwise the panel takes the focus itself. */
  focus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => (typeof document === 'undefined' || !(document.activeElement instanceof HTMLElement) ? null : document.activeElement));
  const returnFocus = () => {
    let to = opener;
    while (to && !to.isConnected) to = openers.get(to) ?? null;
    if (!to || to.tabIndex >= 0) return to ?? true;
    // Base UI would move on to the first thing inside that is tabbable: in the reader, the sender, whose card would open.
    queueMicrotask(() => to.focus({ preventScroll: true }));
    return false;
  };
  const stepping = onPrevious !== undefined || onNext !== undefined;
  return (
    <Base.Root {...useLayerOpen(open, onClose)}>
      <Base.Portal>
        <Backdrop />
        {/* The panel takes the focus itself, not its first button, which Enter would press. */}
        <Base.Popup
          // Kept as the popup is attached, which the portal does after the panel's own effects have run.
          ref={(node) => {
            popup.current = node;
            if (node) openers.set(node, opener);
          }}
          tabIndex={-1}
          initialFocus={focus ?? popup}
          finalFocus={returnFocus}
          className={`focus-within-shown fixed inset-y-0 right-0 z-50 flex w-full flex-col border-(--frame) bg-card pr-(--safe-right) pb-(--safe-bottom) [--layer-top:var(--safe-top)] [--surface:var(--card)] text-sm outline-none transition-transform duration-150 ease-out data-ending-style:pointer-events-none data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none md:border-l ${narrow ? 'md:w-[min(44rem,100vw)]' : 'md:w-[min(max(75vw,66rem),80rem,100vw)]'}`}
        >
          <KeyLayer moves>
            <LayerContent title={title} subtitle={subtitle}>
              {children}
            </LayerContent>
            <AboveToasts>
              {actions ? <LayerFooter>{actions}</LayerFooter> : null}
              {stepping ? (
                <ControlBar start={position} className="border-t border-(--rule) px-3 py-1.5 md:px-4">
                  <Control
                    label="Previous"
                    keys={[]}
                    icon={<ChevronLeftIcon aria-hidden className="size-4" />}
                    disabled={!onPrevious}
                    onClick={() => onPrevious?.()}
                  />
                  <Control
                    label="Next"
                    keys={[]}
                    icon={<ChevronRightIcon aria-hidden className="size-4" />}
                    iconAfter
                    disabled={!onNext}
                    onClick={() => onNext?.()}
                    className="phone:order-3"
                  />
                </ControlBar>
              ) : null}
            </AboveToasts>
          </KeyLayer>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}
