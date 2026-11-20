/** How far back Inbox keeps a person's mail: the last year, the last three years, or all of it. Mail in the inbox is kept however old. */
export const MAIL_WINDOWS = ['year', 'three_years', 'all'] as const;
export type MailWindow = (typeof MAIL_WINDOWS)[number];

const YEAR_MS = 365 * 86_400_000;
const YEARS: Record<MailWindow, number | null> = { year: 1, three_years: 3, all: null };

/** Where a window begins at `now`: Inbox keeps mail received since. Null: all of it. */
export const windowStart = (window: MailWindow, now: number): number | null => {
  const years = YEARS[window];
  return years === null ? null : now - years * YEAR_MS;
};
