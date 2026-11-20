'use client';
import { PlusIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ErrorNote } from '@/components/bits.tsx';
import { type LabelSummary, api, useLoaded } from '@/lib/api.ts';
import { useOpened } from '@/lib/params.ts';
import { AddLabelsDialog, LabelPanel, weak } from '@/views/label-panel.tsx';
import { INBOX, count, percent } from '@/lib/format.ts';
import { Heads, Blank, Button, Empty, ListView, Look, Section, Share, Sub, Table, Td, Th, Tr } from '@/system';

/** What Sift does with a label's mail, as the page groups it: blocking is marking spam, and more. */
const GROUPS = [
  { title: 'Kept in your inbox', has: (l: LabelSummary) => l.disposition === 'keep' },
  { title: 'Archived', has: (l: LabelSummary) => l.disposition === 'archive' },
  { title: 'In a daily digest', has: (l: LabelSummary) => l.disposition === 'digest' },
  { title: 'Marked spam', has: (l: LabelSummary) => l.disposition === 'spam' || l.disposition === 'block' },
] as const;

/** Leave in inbox first, where every list has it; then by name, so a label stays put while it is edited. */
const order = (a: LabelSummary, b: LabelSummary) => Number(b.id === INBOX) - Number(a.id === INBOX) || a.name.localeCompare(b.name);

/** Under a label's name: what it is. Leave in inbox has no words of the person's. */
const about = (label: LabelSummary) => (label.id === INBOX ? 'Mail none of your labels fit' : label.description);

/** How often Sift had the label right when the reader checked, in yellow when it is often wrong. Nothing until then. */
function Right({ label }: { label: LabelSummary }) {
  if (label.record.reviewed === 0) return null;
  const text = percent(label.record.right, label.record.reviewed);
  return weak(label) ? <Look>{text}</Look> : <span className="text-muted-foreground">{text}</span>;
}

/** Labels' own action, adding some, with how many there are of how many Sift keeps. */
export function LabelActions() {
  const { data, reload } = useLoaded('manage', (signal) => api.manage(signal), 10_000);
  const [adding, setAdding] = useState(false);
  // Leave in inbox is not one of the labels the limit counts.
  const own = data ? data.labels.filter((label) => label.id !== INBOX).length : 0;
  const full = !!data && own >= data.labelLimit;
  return (
    <>
      <span className="text-sm text-muted-foreground tabular-nums max-sm:hidden">{data ? `${count(own)} of ${data.labelLimit}` : <Blank word />}</span>
      <Button
        disabled={!data || data.accounts.length === 0 || full}
        {...(full ? { why: `Sift keeps at most ${data?.labelLimit} labels. Remove one you no longer use first.` } : {})}
        onClick={() => setAdding(true)}
      >
        <PlusIcon aria-hidden />
        Add labels
      </Button>
      {adding ? <AddLabelsDialog onClose={() => setAdding(false)} onSaved={reload} /> : null}
    </>
  );
}

/**
 * The labels, under what Sift does with their mail, so the page reads as what happens to it: each with what
 * it is, how much of the mail it is and how often Sift has had it right.
 */
export function LabelsView({ loading: loadingRows }: { loading: ReactNode }) {
  const { data, error, loading, reload } = useLoaded('manage', (signal) => api.manage(signal), 10_000);
  const [open, setOpen] = useOpened('labels');
  const all = data?.labels ?? [];
  const mail = all.reduce((sum, label) => sum + label.messages, 0);
  const groups = GROUPS.map((group) => ({ ...group, rows: all.filter(group.has).toSorted(order) })).filter((g) => g.rows.length > 0);
  // Previous and next go down the page as it reads.
  const listed = groups.flatMap((g) => g.rows);
  const at = listed.findIndex((label) => label.id === open);

  return (
    <ListView>
      {error ? <ErrorNote message={error} /> : null}
      {loading ? (
        loadingRows
      ) : all.length === 0 ? (
        <Empty>No labels yet.</Empty>
      ) : (
        <div className="flex flex-col gap-10 md:gap-12">
          {groups.map((group, index) => {
            const share = group.rows.reduce((sum, label) => sum + label.messages, 0);
            return (
              <Section key={group.title} title={group.title} meta={mail > 0 ? `${percent(share, mail)} of the mail` : undefined}>
                <Table>
                  {/* Over the first group alone: the columns line up down the page. */}
                  <Heads {...(index === 0 ? { shown: 'wide' as const } : {})}>
                    <Th>
                      <span className="sr-only">Label</span>
                    </Th>
                    <Th phone="hide" num>
                      Messages
                    </Th>
                    <Th phone="hide" num>
                      Right
                    </Th>
                  </Heads>
                  <tbody>
                    {group.rows.map((label) => (
                      <Tr key={label.id} onOpen={() => setOpen(label.id)}>
                        <Td className="max-w-0">
                          <span className="name">{label.name}</span>
                          {label.id === INBOX ? <span className="text-muted-foreground"> (Default)</span> : null}
                          {/* On a phone what the label is matters more than the room: two lines, not one. */}
                          <Sub className="phone:line-clamp-2 phone:whitespace-normal">{about(label)}</Sub>
                        </Td>
                        <Td phone="hide" num className="w-48" says={`${percent(label.messages, mail)} of the mail`}>
                          <span className="flex items-center justify-end gap-3">
                            <span className="w-24">
                              <Share part={label.messages} whole={mail} />
                            </span>
                            <span className="w-12 tabular-nums">{count(label.messages)}</span>
                          </span>
                        </Td>
                        <Td
                          phone="hide"
                          num
                          className="w-28"
                          says={label.record.reviewed > 0 ? `${count(label.record.right)} of ${count(label.record.reviewed)} you have ever checked` : undefined}
                        >
                          <Right label={label} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Section>
            );
          })}
        </div>
      )}
      {at !== -1 ? (
        <LabelPanel
          key={listed[at].id}
          label={listed[at]}
          mail={mail}
          position={`${at + 1} of ${listed.length}`}
          onPrevious={at > 0 ? () => setOpen(listed[at - 1].id) : undefined}
          onNext={at < listed.length - 1 ? () => setOpen(listed[at + 1].id) : undefined}
          onClose={() => setOpen('')}
          onSaved={reload}
        />
      ) : null}
    </ListView>
  );
}
