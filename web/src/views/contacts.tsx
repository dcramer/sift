'use client';
import { type ReactNode, useEffect, useState } from 'react';
import { ErrorNote, Verdict } from '@/components/bits.tsx';
import { SenderCell, senderHref } from '@/components/sender.tsx';
import { type ContactPage, api, useLoaded } from '@/lib/api.ts';
import { CONTACT_FILTER, STANDINGS, count, dateTime, plural } from '@/lib/format.ts';
import { paramNow, setParams, useGo, useParam } from '@/lib/params.ts';
import { reveal } from '@/lib/reveal.ts';
import { Ago, Empty, FilterGroup, Heads, ListView, OnPhone, Pager, Table, Td, Th, Tr } from '@/system';

const PAGE = 50;

const STANDING_FILTER = [['', 'Any'] as const, ...STANDINGS.map(([key, , state]) => [key, state] as const)];

/** A narrower list starts at its first page. */
const narrow = (name: string) => (value: string) => setParams({ [name]: value, page: '' });

type Contact = ContactPage['rows'][number];

/** Where they stand: the standing the reader gave them, else how many rules name them or their domain. */
function Standing({ contact }: { contact: Contact }) {
  const given = STANDINGS.find(([key]) => key === contact.given);
  if (given) return <span>{given[2]}</span>;
  return contact.rules > 0 ? <span className="text-muted-foreground">{plural(contact.rules, 'rule')}</span> : null;
}

/** What Sift does with their next mail, as their page says it. */
const Next = ({ contact }: { contact: Contact }) => (
  <>
    {contact.next.usually ? <span className="text-muted-foreground">Usually </span> : null}
    <Verdict labelId={contact.next.labelId} labelName={contact.next.labelName} disposition={contact.next.disposition} />
  </>
);

/** Everyone the reader gets mail from, newest first, each opening their page. `loading` stands in for the rows until they come. */
export function ContactsView({ loading: loadingRows }: { loading: ReactNode }) {
  const go = useGo();
  const [search] = useParam('q');
  const [standing] = useParam('standing', STANDING_FILTER);
  const [know] = useParam('know', CONTACT_FILTER);
  const [page, setPage] = useParam('page');
  const offset = (Math.max(1, Math.floor(Number(page)) || 1) - 1) * PAGE;
  // What the viewer typed, until it is in the address; the address's, before they type.
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => {
    if (typed === null) return;
    const timer = setTimeout(() => {
      if (typed.trim() !== paramNow('q')) narrow('q')(typed.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [typed]);

  const query = { q: search, standing, know, limit: PAGE, offset };
  const { data, error, loading } = useLoaded(`contacts-${JSON.stringify(query)}`, (signal) => api.contacts(query, signal), 120_000);
  const narrowed = search !== '' || standing !== '' || know !== '';

  return (
    <ListView
      search={{ value: typed ?? search, onChange: setTyped, placeholder: 'Search contacts' }}
      filters={{
        active: [
          ...(standing === '' ? [] : [{ label: STANDING_FILTER.find(([k]) => k === standing)?.[1] ?? standing, clear: () => narrow('standing')('') }]),
          ...(know === '' ? [] : [{ label: CONTACT_FILTER.find(([k]) => k === know)?.[1] ?? know, clear: () => narrow('know')('') }]),
        ],
        panel: (
          <>
            <FilterGroup label="Standing" value={standing} options={STANDING_FILTER} onChange={narrow('standing')} />
            <FilterGroup label="How you know them" value={know} options={CONTACT_FILTER} onChange={narrow('know')} />
          </>
        ),
      }}
    >
      {error ? <ErrorNote message={error} /> : null}
      {loading ? (
        loadingRows
      ) : !data || data.rows.length === 0 ? (
        <Empty>{narrowed ? 'Nothing matches.' : 'Everyone who writes to you will be here.'}</Empty>
      ) : (
        <Table>
          <Heads shown="wide">
            <Th>Name</Th>
            <Th phone="hide">Their next mail</Th>
            <Th phone="hide">Standing</Th>
            <Th phone="hide" num says="Messages from them in the last 30 days">
              30 days
            </Th>
            <Th phone="hide" num>
              Latest
            </Th>
          </Heads>
          <tbody>
            {data.rows.map((contact) => {
              const address = reveal(contact.address);
              const name = reveal(contact.name);
              return (
                <Tr key={address} onOpen={() => go(senderHref(address))}>
                  <SenderCell address={address} name={name} contact={contact.contact} term={search}>
                    <OnPhone>
                      {name ? <span className="w-full truncate">{address}</span> : null}
                      <Next contact={contact} />
                    </OnPhone>
                  </SenderCell>
                  <Td phone="hide" className="whitespace-nowrap md:w-full">
                    <Next contact={contact} />
                  </Td>
                  <Td phone="hide" className="whitespace-nowrap">
                    <Standing contact={contact} />
                  </Td>
                  <Td phone="hide" num>
                    {count(contact.recent)}
                  </Td>
                  <Td phone="hide" num quiet says={dateTime(contact.lastSeenAt)}>
                    <Ago at={contact.lastSeenAt} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {data ? <Pager offset={offset} size={PAGE} total={data.total} onGo={(at) => setPage(at === 0 ? '' : String(at / PAGE + 1))} /> : null}
    </ListView>
  );
}
