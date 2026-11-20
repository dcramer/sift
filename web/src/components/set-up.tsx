'use client';
import { ArrowRightIcon, ArrowUpRightIcon, PlusIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type Next, ProviderList, providerName, useProviderConnect } from '@/components/model-connect.tsx';
import { type LabelProposal, type ManageState, api, useLoaded } from '@/lib/api.ts';
import { signOut } from '@/lib/sign-out.ts';
import { useAction } from '@/lib/action.ts';
import { count } from '@/lib/format.ts';
import { InboxFigures, useInboxEstimate } from '@/components/inbox.tsx';
import { Button, Dialog, Failure, Form, Note, Onboarding, TextArea } from '@/system';
import { type LabelDraft, LabelFields } from '@/views/label-panel.tsx';
import { type Suggestion, SuggestionList, keepWord, keptLabels, suggestionOf } from '@/components/label-suggestions.tsx';
import { reveal } from '@/lib/reveal.ts';

type Choice = ManageState['model']['choices'][number];
type Account = { name: string; onSettings: () => void; onSignOut: () => void } | undefined;

/** Things people want of their inbox, to start from. Each one goes once its words are in the box, and the next takes its place. */
const EXAMPLES = [
  'Get sales pitches out of my inbox',
  'Never miss mail from a person',
  'Keep receipts out of the way',
  'Quiet the notifications from tools I use',
  'Catch scams and phishing',
  'Never miss a bill or a failed payment',
  'Keep recruiters out of my inbox',
  'Keep shipping updates out of the way',
  'Never miss a security alert about my accounts',
  'Unsubscribe me from lists I never signed up for',
  'Archive automated reports and digests',
  'Never miss mail from my kids’ school',
  'Archive social network notifications',
  'Tag my travel bookings so I can find them',
  'Archive surveys and feedback requests',
];
/** How many to offer at once. */
const OFFERED = 6;

/**
 * Nothing of the dashboard shows until Sift can work: a model in use, and labels of the person's own (Sift
 * reads nothing of theirs without them). The steps come in order; one already done is ticked and
 * skipped. A model that is lost later (its sign-in removed or expired) brings back only that step. Once
 * the labels are made, Sift may go through the newest of the inbox to suggest about. Settings opens over it.
 */
export function SetUp({ signedInAs, onSettings, children }: { signedInAs: string | null; onSettings: () => void; children: ReactNode }) {
  const manage = useLoaded('manage', (signal) => api.manage(signal), 60_000);
  const proposal = useLoaded('labelProposal', (signal) => api.labelProposal(signal), 300_000);
  // Each press moves to the next step itself rather than waiting for the next load, which would show a step
  // from before it: suggestions just made, labels just made, older mail asked for.
  const [fresh, setFresh] = useState<LabelProposal | null>(null);
  const [asking, setAsking] = useState(false);
  const [made, setMade] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const state = manage.data;
  // Until it is known which, the dashboard, as the server drew it: most who open it have set up long ago.
  if (!state) return children;
  const inUse = state.model.chosen?.split('/')[0] ?? null;
  const walled = inUse === null || !state.model.signedIn.includes(inUse);
  const bare = !made && !state.labels.some((l) => l.gmailLabel !== null);
  if (!walled && !bare && !teaching) return children;
  const account: Account = signedInAs
    ? {
        name: state.accounts.find((a) => a.primary)?.email ?? signedInAs,
        onSettings,
        onSignOut: () => void signOut(),
      }
    : undefined;
  const steps = ['Connect a model', 'What you want', 'Your labels', 'Older mail'];
  // A model signed out after setting up is the only thing to do: no steps.
  const lost = walled && !bare && inUse !== null;

  if (walled) return <Connect state={state} lost={lost ? inUse : null} steps={lost ? undefined : steps} account={account} reload={manage.reload} />;
  if (teaching) return <Teach state={state} steps={steps} account={account} onDone={() => setTeaching(false)} />;
  // Suggestions kept from an earlier visit decide the step, so it waits for them.
  if (!proposal.data && !proposal.error && !fresh) return null;
  const suggested = fresh ?? proposal.data?.proposal ?? null;
  if (suggested && !asking)
    return (
      <Labels
        key={suggested.id}
        proposal={suggested}
        steps={steps}
        account={account}
        onStartOver={() => setAsking(true)}
        onDone={() => {
          setMade(true);
          setTeaching(true);
        }}
      />
    );
  return (
    <Want
      start={reveal(suggested?.goal) ?? ''}
      steps={steps}
      account={account}
      onSuggested={(next) => {
        setFresh(next);
        setAsking(false);
      }}
    />
  );
}

function Connect({
  state,
  lost,
  steps,
  account,
  reload,
}: {
  state: ManageState;
  lost: string | null;
  steps: readonly string[] | undefined;
  account: Account;
  reload: () => void;
}) {
  const [picked, setPicked] = useState<Choice | null>(null);
  if (picked)
    return <Provider key={picked.provider} choice={picked} state={state} steps={steps} account={account} reload={reload} onBack={() => setPicked(null)} />;
  const was = lost
    ? providerName(
        state.model.choices.find((c) => c.provider === lost),
        lost,
      )
    : null;
  return (
    <Onboarding
      {...(steps ? { steps } : {})}
      title={was ? 'No model connected' : 'Connect a model'}
      intro={
        was
          ? `${was} is signed out, so nothing new is classified or suggested. Rules still label what they cover.`
          : 'It reads the mail no rule covers and says which of your labels it is. Nothing in Gmail changes until you let it.'
      }
      account={account}
    >
      <ProviderList choices={state.model.choices} inUse={null} onChoose={setPicked} />
    </Onboarding>
  );
}

function Provider({
  choice,
  state,
  steps,
  account,
  reload,
  onBack,
}: {
  choice: Choice;
  state: ManageState;
  steps: readonly string[] | undefined;
  account: Account;
  reload: () => void;
  onBack: () => void;
}) {
  const step = useProviderConnect(choice, state.model, reload);
  const { busy, error, run } = useAction();
  const ready = step.ready;
  return (
    <Onboarding {...(steps ? { steps } : {})} title={step.title} account={account}>
      {step.body}
      <Onward
        next={step.next ?? { label: 'Continue', busy, disabled: !ready, onPress: () => ready && run(() => api.setModel(ready), reload) }}
        back={{ label: 'Back', onPress: onBack }}
        error={error}
      />
    </Onboarding>
  );
}

function Want({
  start,
  steps,
  account,
  onSuggested,
}: {
  start: string;
  steps: readonly string[];
  account: Account;
  onSuggested: (proposal: LabelProposal) => void;
}) {
  const [goal, setGoal] = useState(start);
  const { busy, error, run } = useAction();
  const ready = goal.trim() !== '';
  const suggest = () => ready && run(async () => onSuggested(await api.proposeLabels(goal.trim())));
  return (
    <Onboarding
      steps={steps}
      current={1}
      title="What do you want from Sift?"
      intro="What you want out of your way, and what you never want to miss, in your own words. Sift suggests labels for it, mostly for mail to move. Mail none of them fits stays in your inbox."
      account={account}
    >
      <Form onSubmit={suggest}>
        <TextArea
          aria-label="What do you want from Sift?"
          className="min-h-32"
          maxLength={2000}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <ul className="-ml-3 flex flex-col items-start" aria-label="Examples">
          {EXAMPLES.filter((example) => !goal.toLowerCase().includes(example.toLowerCase()))
            .slice(0, OFFERED)
            .map((example) => (
              <li key={example}>
                <Button variant="quiet" onClick={() => setGoal((g) => (g.trim() ? `${g.trim()} ${example}.` : `${example}.`))}>
                  <PlusIcon aria-hidden />
                  {example}
                </Button>
              </li>
            ))}
        </ul>
      </Form>
      <Onward next={{ label: 'Suggest labels', busy, disabled: !ready, onPress: suggest }} error={error} waiting={busy ? 'This can take a minute.' : null} />
    </Onboarding>
  );
}

function Labels({
  proposal,
  steps,
  account,
  onStartOver,
  onDone,
}: {
  proposal: LabelProposal;
  steps: readonly string[];
  account: Account;
  onStartOver: () => void;
  onDone: () => void;
}) {
  const [suggestions, setSuggestions] = useState(() => proposal.drafts.map(suggestionOf));
  const [editing, setEditing] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const kept = keptLabels(suggestions);
  const change = (index: number, next: Partial<Suggestion>) => setSuggestions((all) => all.map((d, i) => (i === index ? { ...d, ...next } : d)));
  const use = () => kept.length > 0 && run(() => api.acceptLabels(kept), onDone);
  return (
    <Onboarding steps={steps} current={2} title="Your labels" intro={`“${reveal(proposal.goal)}”`} account={account}>
      {proposal.note ? (
        <Note tone="look" title="Not in these labels">
          {reveal(proposal.note)}
        </Note>
      ) : null}
      {suggestions.length > 0 ? (
        <>
          <SuggestionList suggestions={suggestions} onChange={change} onEdit={setEditing} />
          <Onward
            next={{ label: keepWord('Use', kept.length), busy, disabled: kept.length === 0, onPress: use }}
            back={{ label: 'Start over', onPress: onStartOver }}
            error={error}
          />
        </>
      ) : (
        <Onward next={{ label: 'Start over', onPress: onStartOver }} error={error} />
      )}
      {editing === null ? null : (
        <EditDraft
          draft={suggestions[editing]}
          onClose={() => setEditing(null)}
          onSave={(draft) => {
            change(editing, draft);
            setEditing(null);
          }}
        />
      )}
    </Onboarding>
  );
}

/** A suggestion changed before it is made: the fields a label has on the Labels screen. */
function EditDraft({ draft: start, onClose, onSave }: { draft: LabelDraft; onClose: () => void; onSave: (draft: LabelDraft) => void }) {
  const [draft, setDraft] = useState(start);
  const ready = draft.name.trim() !== '';
  const save = () => ready && onSave({ ...draft, name: draft.name.trim(), description: draft.description.trim() });
  return (
    <Dialog
      open
      onClose={onClose}
      title={start.name}
      footer={
        <>
          <Button variant="ink" disabled={!ready} onClick={save}>
            Done
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <Form onSubmit={save}>
        <LabelFields draft={draft} onChange={setDraft} />
      </Form>
    </Dialog>
  );
}

function Teach({ state, steps, account, onDone }: { state: ManageState; steps: readonly string[]; account: Account; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const estimate = useInboxEstimate('recent');
  const messages = estimate.data?.messages ?? null;
  return (
    <Onboarding
      steps={steps}
      current={3}
      title="Older mail"
      intro={`Sift reads new mail from now on. Have it go through the newest mail already in ${new Intl.ListFormat('en', { type: 'conjunction' }).format(state.accounts.map((a) => a.email))} as well, and answer what it says: it learns from your answers.`}
      account={account}
    >
      <InboxFigures estimate={estimate.data} model={state.model} />
      <Onward
        next={{
          label: messages === null ? 'Go through' : `Go through ${count(messages)}`,
          busy,
          disabled: !messages,
          onPress: () => run(() => api.startInbox('recent'), onDone),
        }}
        back={{ label: 'New mail only', onPress: onDone }}
        error={error ?? estimate.error}
      />
    </Onboarding>
  );
}

/** How a step ends: the one thing to press, at most one other way, and what is happening or went wrong. */
function Onward({
  next,
  back,
  error,
  waiting = null,
}: {
  next: Next;
  back?: { label: string; onPress: () => void };
  error: string | null;
  waiting?: string | null;
}) {
  const disabled = next.disabled ?? false;
  // A link while it can be followed; a disabled button until then, since a link cannot be disabled.
  const link = next.href !== undefined && !disabled ? { href: next.href, target: '_blank', rel: 'noreferrer' } : { disabled };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3 pt-2">
      <Button variant="mark" size="lg" busy={next.busy ?? false} onClick={next.onPress} {...link}>
        {next.label}
        {next.href ? <ArrowUpRightIcon aria-hidden /> : <ArrowRightIcon aria-hidden />}
      </Button>
      {back ? (
        <Button variant="quiet" size="lg" onClick={back.onPress}>
          {back.label}
        </Button>
      ) : null}
      {waiting ? <span className="text-sm text-muted-foreground">{waiting}</span> : null}
      <Failure>{error}</Failure>
    </div>
  );
}
