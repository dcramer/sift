import type { Ephemeral } from '../ephemeral/ephemeral.ts';
import { traced } from '../telemetry.ts';

/** Waits until `units` of the mailbox's Gmail quota may be spent, then counts them. */
export type Pace = (units: number) => Promise<void>;

/**
 * Google allows each user 6,000 quota units a minute ([docs/gmail.md](../../docs/gmail.md)); past that it
 * answers 429, which a pass treats as any failure. A bucket of 1,000 refilling at 4,800 a minute keeps any
 * 60 seconds under 6,000, and a call waits for its units instead of failing.
 */
const BUCKET = { burst: 1_000, perMinute: 4_800 };

/** What one mailbox's work spends of Gmail's quota a minute, sustained. */
export const QUOTA_PER_MINUTE = BUCKET.perMinute;

export const pacer =
  (ephemeral: Ephemeral, account: string): Pace =>
  async (units) => {
    const wait = await ephemeral.reserve(`quota:${account}`, units, BUCKET);
    if (wait > 0) await traced('sift.wait', 'gmail quota', { 'sift.wait_ms': wait }, () => new Promise((resolve) => setTimeout(resolve, wait)));
  };
