import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip.tsx';

const NAMES = ['', 'Unsure', 'Fairly sure', 'Sure'] as const;

/**
 * How sure sift is, in three steps of ink: one, two or three bars lit. Sits before what it qualifies,
 * inside a row's answer. Its name is read out, so the bars need no legend. With no `level` (mail Sift could not
 * place) it is only the room the bars take, so a column of answers starts its words in one place.
 */
export function Meter({ level }: { level: 1 | 2 | 3 | null }) {
  if (level === null) return <span aria-hidden className="inline-block w-[13px] shrink-0" />;
  return (
    <Tooltip says={NAMES[level]} className="inline-flex shrink-0">
      <span role="img" aria-label={NAMES[level]} className="inline-flex items-end gap-[2px]">
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={cn('w-[3px]', step === 1 ? 'h-[6px]' : step === 2 ? 'h-[9px]' : 'h-3', step <= level ? 'bg-muted-foreground' : 'bg-foreground/20')}
          />
        ))}
      </span>
    </Tooltip>
  );
}
