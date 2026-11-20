'use client';
import { Dialog as Base } from '@base-ui/react/dialog';
import type { ReactNode } from 'react';
import { useBackCloses } from '@/lib/params.ts';
import { cn } from '@/lib/utils';
import { KeyLayer } from './keys.tsx';
import { Backdrop, LayerContent, LayerFooter, useLayerOpen } from './layer.tsx';
import { AboveToasts } from './toast.tsx';

/**
 * Something opened from the page and read or answered without leaving it: one message, one sender, a
 * form. Centred over the page; covers the screen on a phone. Closes on Escape, a press outside or Back.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  /** Stays in view under the content: the actions that finish the dialog. */
  footer?: ReactNode;
  /** None for a question its title and footer say whole. */
  children?: ReactNode;
}) {
  const layer = useLayerOpen(open, onClose);
  useBackCloses(open, () => layer.onOpenChange(false));
  return (
    <Base.Root {...layer}>
      <Base.Portal>
        <Backdrop />
        <Base.Popup
          className={cn(
            'sheet fixed inset-0 z-50 flex flex-col bg-card [--surface:var(--card)] phone:pb-(--safe-bottom) phone:[--layer-top:var(--safe-top)] text-sm outline-none transition-[opacity,scale] duration-150 ease-out data-ending-style:pointer-events-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none',
            'md:inset-auto md:top-1/2 md:left-1/2 md:max-h-[calc(100svh-4rem)] md:w-[calc(100vw-4rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:max-w-xl',
          )}
        >
          <KeyLayer>
            <LayerContent title={title} subtitle={subtitle}>
              {children}
            </LayerContent>
            {footer ? (
              <AboveToasts>
                <LayerFooter>{footer}</LayerFooter>
              </AboveToasts>
            ) : null}
          </KeyLayer>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}
