'use client';
import { useState } from 'react';
import { api } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { setParams, useParam } from '@/lib/params.ts';
import { reveal } from '@/lib/reveal.ts';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The start of a `YYYY-MM-DD` in this browser's days; null for anything else. */
const startOf = (day: string) => {
  const parts = DAY.exec(day);
  return parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime() : null;
};
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const values = (list: string) => (list === '' ? [] : list.split(','));

/**
 * Inbox's Ask: the words in the search put to the model, which answers with a filter. The filter goes into the address
 * as the list's own (who sent it, label, view, unread, since), each shown as a chip that clears it, and the words to
 * search for into the search, so the reader sees what the model made and changes it as any filter. What the model says
 * it could not narrow by is `said`.
 */
export function useAsk() {
  const [from, setFrom] = useParam('from');
  const [domain, setDomain] = useParam('domain');
  const [since, setSince] = useParam('since');
  const [said, setSaid] = useState<string | null>(null);
  const asking = useAction();
  const without = (list: string, value: string) =>
    values(list)
      .filter((v) => v !== value)
      .join(',');
  const sinceAt = startOf(since);
  return {
    query: { from, domain, since: sinceAt },
    narrowed: from !== '' || domain !== '' || sinceAt !== null,
    active: [
      ...values(from).map((v) => ({ label: `From: ${v}`, clear: () => setFrom(without(from, v)) })),
      ...values(domain).map((v) => ({ label: `From: anyone at ${v}`, clear: () => setDomain(without(domain, v)) })),
      ...(sinceAt === null
        ? []
        : [{ label: `Since ${new Date(sinceAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, clear: () => setSince('') }]),
    ],
    said,
    busy: asking.busy,
    error: asking.error,
    ask: (words: string) => {
      setSaid(null);
      asking.run(async () => {
        const answer = await api.askMail(words, today());
        if ('cannot' in answer) {
          setSaid(reveal(answer.cannot));
          return;
        }
        const filter = reveal(answer.filter);
        setParams({
          q: (filter.words ?? []).join(' '),
          from: (filter.from ?? []).join(','),
          domain: (filter.domain ?? []).join(','),
          since: filter.since ?? '',
          label: filter.label ?? '',
          view: filter.view ?? '',
          unread: filter.unread ? '1' : '',
        });
        setSaid(answer.note ? reveal(answer.note) : null);
      });
    },
  };
}
