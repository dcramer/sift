'use client';
import { ArrowLeftIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { ErrorNote, StatusWord, Verdict } from '@/components/bits.tsx';
import { ContactHint, DomainLink, NameCell, SenderCell, SenderFacts, senderHref } from '@/components/sender.tsx';
import { type Given, type ListedDecision, type SenderPage, api, useLoaded } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { INBOX, STANDINGS, count, dateTime, describeMatch, doesName, duration, longDay, outcomeName, percent, shortDay } from '@/lib/format.ts';
import { type RuleStart, addedWords, messageStart, nameStart, standingStart } from '@/lib/rule-start.ts';
import { useCompose } from '@/lib/compose.ts';
import { messageKey, rulePath, useGo, useOpenRule, useParam } from '@/lib/params.ts';
import { RuleDialog } from '@/views/rule-dialog.tsx';
import {
  Ago,
  Heads,
  Button,
  ChoiceGroup,
  Empty,
  Failure,
  Loading,
  OnPhone,
  PageHeader,
  RowActions,
  Section,
  Select,
  Share,
  StackedBars,
  Table,
  Td,
  TextLink,
  Th,
  Tr,
  useToast,
} from '@/system';
import { type OpenMessages, useOpenMessages } from '@/lib/open-messages.ts';
import { useStarted } from '@/system/started.ts';
import { reveal } from '@/lib/reveal.ts';

const GIVE = STANDINGS.map(([key, press]) => [key, press] as const);

type Who = { address: string } | { domain: string };
type Rule = SenderPage['profile']['rules'][number];

/** One row per message, its latest decision, newest mail first: a message answered or decided again has several. */
function byMessage(rows: readonly ListedDecision[]): ListedDecision[] {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.messageId) && seen.add(row.messageId)).toSorted((a, b) => b.receivedAt - a.receivedAt);
}

/** Mail no rule placed that Sift has not carried out and the reader has not answered. */
const isWaiting = (row: ListedDecision) => !row.byUser && !row.carryOut && row.outcome === null && row.stage !== 'rules';

const ruleWords = (rule: Rule) =>
  `${reveal(rule.name) ?? `Mail ${describeMatch(reveal(rule.match))}`}${
    rule.kind === 'action' || rule.labelId === INBOX
      ? `: ${rule.disposition || rule.labelId === INBOX ? doesName(rule.labelId, rule.disposition ?? 'keep') : 'nothing'}`
      : `${rule.kind === 'when-label' ? ', when it is ' : ' is '}${rule.labelName ?? ''}`
  }`;

/** What happens to their next message, and what says so: the rule that decides it, or their mail, with how often Sift has been right. */
function NextMail({ data }: { data: SenderPage }) {
  const { next } = data;
  const rule = data.profile.rules.find((r) => r.id === next.ruleId);
  const { right, wrong } = data.profile.answers;
  const others = data.profile.rules.filter((r) => r !== rule);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="slug text-muted-foreground">Their next mail</p>
      <p className="heading">
        {next.usually ? <span className="text-muted-foreground">Usually </span> : null}
        <Verdict labelId={next.labelId} labelName={next.labelName} disposition={next.disposition} />
      </p>
      <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        {[...(rule ? [rule] : []), ...others].map((r) => (
          <li key={r.id}>
            <TextLink href={rulePath(r.id)}>{ruleWords(r)}</TextLink>
          </li>
        ))}
        {rule ? null : (
          <li>
            {data.profile.rules.length > 0 ? 'Otherwise the model decides each one' : 'The model decides each one'}
            {right + wrong > 0 ? `; right ${count(right)} of ${count(right + wrong)} times you checked` : ''}
          </li>
        )}
        {data.profile.saved.messages > 0 ? (
          <li>
            {count(data.profile.saved.messages)} kept out of your inbox, about {duration(data.profile.saved.seconds)}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

const DAY = 24 * 3_600_000;
const WEEK = 7 * DAY;

/** Below this many messages a chart of them is a bar or two in an empty frame; the line above it says as much. */
const CHARTED = 5;

/** Their mail over time: twelve weeks, or two weeks by day for someone new. */
function Volume({ rows, firstSeenAt, now }: { rows: ListedDecision[]; firstSeenAt: number | null; now: number }) {
  const daily = firstSeenAt !== null && now - firstSeenAt < 3 * WEEK;
  const step = daily ? DAY : WEEK;
  const length = daily ? 14 : 12;
  const start = now - length * step;
  const columns = Array.from({ length }, (_, i) => {
    const day = new Date(start + (i + 1) * step - DAY).toISOString().slice(0, 10);
    const values: Record<string, number> = {};
    return { key: day, label: shortDay(day), title: daily ? longDay(day) : `Week to ${shortDay(day)}`, values };
  });
  for (const row of rows) {
    const column = columns[Math.floor((row.receivedAt - start) / step)];
    if (column) column.values['mail'] = (column.values['mail'] ?? 0) + 1;
  }
  return <StackedBars series={[{ key: 'mail', name: 'Messages', color: 'var(--handled-changed)' }]} rows={columns} compact />;
}

/** What their mail is, label by label, each with a rule to start on it. */
function Labels({ data, onStart }: { data: SenderPage; onStart: (s: RuleStart) => void }) {
  const whole = data.profile.labels.reduce((sum, l) => sum + l.messages, 0);
  return (
    <Table>
      <Heads>
        <Th>Label</Th>
        <Th phone="hide">Share</Th>
        <Th num>Messages</Th>
        <Th>Rule</Th>
      </Heads>
      <tbody>
        {data.profile.labels.map((label) => (
          <Tr key={label.id}>
            <Td className="font-medium whitespace-nowrap">{label.name}</Td>
            <Td phone="hide" className="w-full">
              <Share part={label.messages} whole={whole} />
            </Td>
            <Td num className="whitespace-nowrap">
              {count(label.messages)} <span className="text-muted-foreground">· {percent(label.messages, whole)}</span>
            </Td>
            <RowActions>
              <Button variant="quiet" onClick={() => onStart(messageStart(reveal(data.profile.address), label.id))}>
                Make a rule…
              </Button>
            </RowActions>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

type Named = SenderPage['names'][number];

/** What a name's mail is: its labels, most first, then what rules did to the rest, then whether some has none yet. */
function NameIs({ name }: { name: Named }) {
  const placed = [...name.labels, ...name.actions];
  const unplaced = name.messages - placed.reduce((sum, l) => sum + l.messages, 0);
  const words = [...name.labels.map((l) => l.name), ...name.actions.map((a) => doesName(null, a.action)), ...(unplaced > 0 ? [outcomeName('review')] : [])];
  return <span className={placed.length === 0 ? 'text-muted-foreground' : ''}>{words.join(' · ')}</span>;
}

/** Each name an address writes under, what its mail is, and a rule started on that name. */
function Names({ data, onStart }: { data: SenderPage; onStart: (s: RuleStart) => void }) {
  const whole = data.names.reduce((sum, n) => sum + n.messages, 0);
  return (
    <Table>
      <Heads>
        <Th>Name</Th>
        <Th phone="hide">Share</Th>
        <Th phone="hide" num>
          Messages
        </Th>
        <Th phone="hide">What it is</Th>
        <Th>Rule</Th>
      </Heads>
      <tbody>
        {data.names.map((n) => (
          <Tr key={reveal(n.name) ?? ''}>
            <NameCell address={reveal(data.profile.address)} name={reveal(n.name)}>
              <OnPhone>
                <NameIs name={n} />
                <span>{count(n.messages)}</span>
              </OnPhone>
            </NameCell>
            <Td phone="hide" className="w-full">
              <Share part={n.messages} whole={whole} />
            </Td>
            <Td phone="hide" num className="whitespace-nowrap">
              {count(n.messages)} <span className="text-muted-foreground">· {percent(n.messages, whole)}</span>
            </Td>
            <Td phone="hide" className="whitespace-nowrap">
              <NameIs name={n} />
            </Td>
            <RowActions phone="keep">
              {n.name === null ? null : (
                <Button
                  variant="quiet"
                  onClick={() => n.name !== null && onStart(nameStart(reveal(data.profile.address), reveal(n.name), n.labels[0]?.id ?? null))}
                >
                  Make a rule…
                </Button>
              )}
            </RowActions>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Their mail, one row per message: what it is, what Sift said, where it got to, when it came. Who sent each
 * comes first: on a domain's page the sender, as in every list of mail; for an address with several names, the name.
 */
function Mail({ rows, onOpen, from }: { rows: ListedDecision[]; onOpen: OpenMessages; from: 'sender' | 'name' | null }) {
  const oneSender = from === null;
  const items = rows.map((r) => ({ accountId: r.accountId, messageId: r.messageId, subject: r.subject }));
  return (
    <Table>
      <Heads shown="always">
        {from === 'sender' ? <Th>Sender</Th> : from === 'name' ? <Th>From</Th> : null}
        <Th {...(oneSender ? {} : { phone: 'hide' as const })}>Message</Th>
        <Th phone="hide">Sift said</Th>
        <Th phone="hide">Status</Th>
        <Th phone="hide" num>
          Received
        </Th>
      </Heads>
      <tbody>
        {rows.map((row, index) => {
          const subject = row.subject || '(no subject)';
          const onPhone = (
            <OnPhone>
              {oneSender ? null : <span className="w-full truncate text-base text-foreground">{reveal(subject)}</span>}
              <Verdict labelId={row.labelId} labelName={row.labelName} disposition={row.disposition} />
              <span>
                <Ago at={row.receivedAt} />
              </span>
            </OnPhone>
          );
          return (
            <Tr key={row.id} onOpen={() => onOpen(items, index)} holds={[messageKey(row)]}>
              {oneSender ? (
                <Td className="max-w-0 md:w-1/2">
                  <span className="block truncate font-medium">{reveal(subject)}</span>
                  {onPhone}
                </Td>
              ) : (
                <>
                  {from === 'sender' ? (
                    <SenderCell address={reveal(row.fromAddress)} name={reveal(row.fromName)} contact={row.contact}>
                      {onPhone}
                    </SenderCell>
                  ) : (
                    <NameCell address={reveal(row.fromAddress)} name={reveal(row.fromName)}>
                      {onPhone}
                    </NameCell>
                  )}
                  <Td phone="hide" className="max-w-0 md:w-full">
                    <span className="block truncate">{reveal(subject)}</span>
                  </Td>
                </>
              )}
              <Td phone="hide" className="whitespace-nowrap">
                <Verdict labelId={row.labelId} labelName={row.labelName} disposition={row.disposition} />
              </Td>
              <Td phone="hide" className="whitespace-nowrap">
                <StatusWord row={row} />
              </Td>
              <Td phone="hide" num quiet says={dateTime(row.receivedAt)}>
                <Ago at={row.receivedAt} />
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/**
 * Everything about one sender, or one domain: what Sift will do with their next mail and why, the one
 * place to change that, how much they send and what it is, and their mail.
 */
/**
 * A sender's or a domain's page, `/sender/<address>` or `/domain/<domain>`, from all of the person's mailboxes. The
 * server draws the same page for every one of them, so no address is in its HTML: the page reads it from the address bar.
 */
export function WhoView({ kind, shell }: { kind: 'sender' | 'domain'; shell: ReactNode }) {
  // The server drew this page once for every address, so the address is read only once the page has started.
  const path = usePathname();
  const [, , key] = (useStarted() ? path : '').split('/');
  if (!key) return shell;
  const value = decodeURIComponent(key);
  return <SenderView key={`${kind}/${value}`} who={kind === 'sender' ? { address: value } : { domain: value }} />;
}

function SenderView({ who }: { who: Who }) {
  const onOpen = useOpenMessages();
  const key = 'address' in who ? who.address : who.domain;
  const { data, error, loading, reload } = useLoaded(`${'address' in who ? 'sender' : 'domain'}-page-${key}`, (signal) =>
    'address' in who ? api.sender(who.address, signal) : api.domain(who.domain, signal),
  );
  const go = useGo();
  const compose = useCompose();
  const give = useAction();
  const openRule = useOpenRule();
  // Undo is pressed after the standing is given, so what it reports goes to a toast.
  const later = useAction();
  const toast = useToast();
  // Every other rule this page starts opens the rule dialog on it, to see and change before adding.
  const [starting, setStarting] = useState<RuleStart | null>(null);
  const manage = useLoaded('manage', (signal) => api.manage(signal), 60_000);
  // A standing is a rule for exactly them that says only what happens to their mail, so it is given in one press, with Undo.
  const giveStanding = (standing: Given) =>
    give.run(async () => {
      const given = await api.giveStanding(who, standing);
      // Their own rule says more than a standing would: the dialog shows what replacing it loses.
      if ('theirs' in given) return setStarting(standingStart(who, standing));
      const takeBack = () =>
        later.run(
          () =>
            (given.was ? api.giveStanding(who, given.was) : api.clearStanding(who)).catch((failure: unknown) => {
              toast('Could not take the rule back', { tone: 'failure', description: failure instanceof Error ? failure.message : String(failure) });
              throw failure;
            }),
          reload,
        );
      toast(addedWords(standingStart(who, standing), manage.data?.labels ?? []), {
        kind: given.was ? 'Rule replaced' : 'Rule added',
        undo: takeBack,
        // Mail already in the inbox stays until the rule is applied there, as the dialog offers.
        ...(standing === 'trusted' ? {} : { action: { label: 'Apply to inbox…', onPress: () => openRule(given.id, true) } }),
      });
    }, reload);
  const [now] = useState(() => Date.now());
  // Their mail under one name; the rest of the page is the whole address. A link names the name it was
  // pressed on, which only narrows the mail where there is a From to show it.
  const [named, setUnder] = useParam('name');
  const under = data && data.names.length > 1 ? named : '';
  const narrowed = useLoaded(`sender-page-${key}-under-${under}`, (signal) =>
    'address' in who && under !== '' ? api.sender(who.address, signal, under) : Promise.resolve(null),
  );
  if (error && !data) return 'domain' in who ? <Empty>{error}</Empty> : <ErrorNote message={error} />;
  if (loading || !data)
    return (
      <div className="flex flex-col gap-10">
        <ToContacts />
        <PageHeader title={key} meta={null} />
        <Loading />
      </div>
    );

  const { profile } = data;
  const several = data.names.length > 1;
  // One name would stand for all their mail; with several, the address is who they are.
  const title = several ? null : reveal(data.name);
  const mail = byMessage(data.decisions);
  const listed = under !== '' && narrowed.data ? byMessage(narrowed.data.decisions) : mail;
  const waiting = mail.filter(isWaiting);
  const items = waiting.map((r) => ({ accountId: r.accountId, messageId: r.messageId, subject: r.subject }));
  const [top] = profile.labels;
  const charted = profile.messages >= CHARTED;
  const domain = profile.domain ? reveal(profile.domain.name) : null;
  const naming = [
    ...(title ? [<span key="address">{key}</span>] : []),
    ...(domain
      ? [
          // The hint belongs to the domain: on a phone it wraps with it, never onto a line of its own.
          <span key="domain" className="inline-flex items-center gap-1 whitespace-nowrap">
            <DomainLink domain={domain} />
            <ContactHint contact={profile.domain?.contact ?? null} />
          </span>,
        ]
      : []),
  ].flatMap((part, index) => [
    ...(index > 0
      ? [
          <span key={`dot ${index}`} aria-hidden>
            ·
          </span>,
        ]
      : []),
    part,
  ]);
  // How they know each other takes a line of its own on a phone, where a dot would end the line above.
  const meta =
    naming.length > 0 || profile.contact ? (
      <>
        {naming}
        {profile.contact ? (
          <>
            {naming.length > 0 ? (
              <span aria-hidden className="phone:hidden">
                ·
              </span>
            ) : null}
            <span className="phone:basis-full">
              <ContactHint contact={profile.contact} said />
            </span>
          </>
        ) : null}
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <ToContacts />
        <PageHeader
          title={title ?? key}
          meta={meta}
          actions={
            (compose && 'address' in who) || waiting.length > 0 ? (
              <>
                {compose && 'address' in who ? <Button onClick={() => compose({ kind: 'new', to: who.address })}>Write to them</Button> : null}
                {waiting.length > 0 ? (
                  <Button variant="mark" onClick={() => onOpen(items, 0)}>
                    Answer {count(waiting.length)} waiting
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-12 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-5">
            <NextMail data={data} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ChoiceGroup
                label={`Where ${title ?? key} stands`}
                value={profile.given}
                options={GIVE}
                clearable
                disabled={give.busy}
                onChange={(standing) => (standing ? giveStanding(standing) : give.run(() => api.clearStanding(who), reload))}
              />
              <Button variant="quiet" onClick={() => setStarting(messageStart(key, top?.id ?? null))}>
                Make a rule…
              </Button>
            </div>
            <Failure>{give.error}</Failure>
          </div>
          <SenderFacts profile={profile} on="page" />
          {charted ? <Volume rows={mail} firstSeenAt={profile.firstSeenAt} now={now} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-12">
          {data.senders.length > 0 ? (
            <Section title="People here" meta={count(data.senders.length)}>
              <Table>
                <Heads shown="always">
                  <Th>Name</Th>
                  <Th num>Messages</Th>
                  <Th phone="hide" num>
                    Latest
                  </Th>
                </Heads>
                <tbody>
                  {data.senders.map((sender) => (
                    <Tr key={reveal(sender.address)} onOpen={() => go(senderHref(reveal(sender.address)))}>
                      <SenderCell address={reveal(sender.address)} name={reveal(sender.name)} contact={sender.contact} />
                      <Td num className="md:w-full">
                        {count(sender.messages)}
                      </Td>
                      <Td phone="hide" num quiet says={dateTime(sender.lastSeenAt)}>
                        <Ago at={sender.lastSeenAt} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          ) : null}

          <Section
            title="Their mail"
            meta={count(listed.length)}
            action={
              several ? (
                <Select
                  label="From"
                  value={under}
                  options={[['', 'Every name'] as const, ...data.names.flatMap((n) => (n.name === null ? [] : [[reveal(n.name), reveal(n.name)] as const]))]}
                  onChange={setUnder}
                />
              ) : undefined
            }
          >
            {listed.length === 0 ? (
              <Empty>No mail recorded from them.</Empty>
            ) : (
              <Mail rows={listed} onOpen={onOpen} from={data.kind === 'domain' ? 'sender' : several && under === '' ? 'name' : null} />
            )}
          </Section>

          {several ? (
            <Section title="Names" meta={count(data.names.length)}>
              <Names data={data} onStart={setStarting} />
            </Section>
          ) : profile.labels.length > 1 ? (
            <Section title="What it is" meta={count(profile.labels.length)}>
              <Labels data={data} onStart={setStarting} />
            </Section>
          ) : null}
        </div>
      </div>

      {starting ? <RuleDialog labels={manage.data?.labels ?? []} start={starting} onClose={() => setStarting(null)} onAdded={reload} /> : null}
    </div>
  );
}

/** Up to the list of everyone, which this page is one of. */
function ToContacts() {
  return (
    <Button variant="quiet" href="/contacts" className="-ml-3 self-start">
      <ArrowLeftIcon aria-hidden />
      Contacts
    </Button>
  );
}
