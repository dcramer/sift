'use client';
import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '@/components/bits.tsx';
import { GoThroughInbox, InboxRow, timeLeft } from '@/components/inbox.tsx';
import { useNow } from '@/components/status.tsx';
import { count } from '@/lib/format.ts';
import { MailWindowDialog, TurnInboxOn, windowName } from '@/components/inbox-switch.tsx';
import { ProviderList, providerName, useProviderConnect } from '@/components/model-connect.tsx';
import { costLine, spentLine, subscription } from '@/lib/prices.ts';
import { type ManageState, type Removed, api, useLoaded } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { useParam } from '@/lib/params.ts';
import {
  Ago,
  Button,
  ChoiceGroup,
  ConfirmButton,
  DeleteButton,
  Dialog,
  Failure,
  Kbd,
  Loading,
  Note,
  Panel,
  Select,
  SettingRow,
  SettingsGroup,
  Share,
  Sheet,
  TextLink,
  setShortcutsOn,
  useShortcutsOn,
  useToast,
} from '@/system';

/** Whether sift is on for the reader's own mail: what they come to Settings for first. */
function Active({ state, reload }: { state: ManageState; reload: () => void }) {
  const { busy, error, run } = useAction();
  const { active, activity } = state;
  const [goingThrough, setGoingThrough] = useState(false);
  const save = (active: boolean) =>
    run(
      () => api.setActive(active),
      () => {
        reload();
        // What is already in the inbox stays as it was unless Sift goes through it now.
        if (active && !state.inbox.going) setGoingThrough(true);
      },
    );

  return (
    <SettingsGroup title="Active" note="Whether Sift changes your Gmail.">
      {activity.problems.length > 0 ? (
        <Note tone="failure" title="Not working">
          {activity.problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </Note>
      ) : null}
      <Sheet>
        <SettingRow
          title={active ? 'On' : 'Off'}
          note={
            active ? (
              <>
                Sift carries out its decisions in Gmail as each label says. Each change can be undone from <TextLink href="/activity">Activity</TextLink>.
              </>
            ) : (
              'Nothing in Gmail changes. Sift suggests, and learns from your answers.'
            )
          }
        >
          {active ? (
            <Button busy={busy} onClick={() => save(false)}>
              Turn off
            </Button>
          ) : (
            <ConfirmButton variant="plain" question="Archive, label and mark spam on new mail by itself?" busy={busy} onConfirm={() => save(true)}>
              Turn on
            </ConfirmButton>
          )}
        </SettingRow>
        <InboxRow state={state} reload={reload} onGoThrough={() => setGoingThrough(true)} />
        <DigestRow state={state} reload={reload} />
        {activity.running ? (
          <SettingRow
            title="Check for mail"
            note={
              activity.lastPassAt ? (
                <>
                  Last checked <Ago at={activity.lastPassAt} />.
                </>
              ) : (
                'Starting.'
              )
            }
          >
            <Button disabled={busy} onClick={() => run(() => api.checkNow(), reload)}>
              Check now
            </Button>
          </SettingRow>
        ) : null}
      </Sheet>
      <Failure>{error}</Failure>
      {goingThrough ? <GoThroughInbox model={state.model} onClose={() => setGoingThrough(false)} onStarted={reload} /> : null}
    </SettingsGroup>
  );
}

/** Inbox: reading and handling mail in Sift, with what Sift thinks of each message beside it. */
function Mail({ state, reload }: { state: ManageState; reload: () => void }) {
  const { busy, error, run } = useAction();
  const [changing, setChanging] = useState(false);
  const now = useNow(10_000);
  const { copying } = state;
  return (
    <SettingsGroup title="Inbox" note="Read and handle your mail in Sift.">
      <Sheet>
        <SettingRow
          title={state.mail ? 'On' : 'Off'}
          note={
            state.mail
              ? 'Sift keeps a copy of your mail to show it here. Turning Inbox off deletes that copy.'
              : 'Sift keeps the text only of mail waiting on you, and of the mail you answered for.'
          }
        >
          {state.mail ? (
            <Button busy={busy} onClick={() => run(() => api.setMail(false), reload)}>
              Turn off
            </Button>
          ) : (
            <TurnInboxOn label="Turn on" />
          )}
        </SettingRow>
        {state.mail ? (
          <SettingRow
            title={copying ? `Copying ${windowName(state.mailWindow).toLowerCase()}` : windowName(state.mailWindow)}
            note={
              copying ? (
                <div className="flex flex-col gap-2 pt-1">
                  <Share part={copying.done} whole={Math.max(copying.total, copying.done)} />
                  <span className="tabular-nums">
                    {[`${count(copying.done)} of about ${count(Math.max(copying.total, copying.done))}`, now === null ? null : timeLeft(copying, now)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              ) : (
                'Kept, and whatever is in your inbox however old.'
              )
            }
          >
            <Button onClick={() => setChanging(true)}>Change…</Button>
          </SettingRow>
        ) : null}
      </Sheet>
      <Failure>{error}</Failure>
      {changing ? <MailWindowDialog current={state.mailWindow} onClose={() => setChanging(false)} onDone={reload} /> : null}
    </SettingsGroup>
  );
}

/** The hours of a day, as a clock in any zone reads them: "7:00 AM". */
const HOURS = Array.from({ length: 24 }, (_, hour) => [String(hour), `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`] as const);

/** A time zone as its place reads: "Los Angeles" for `America/Los_Angeles`. */
const REASONING = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
] as const satisfies readonly (readonly [ManageState['model']['reasoning'], string])[];

const placeOf = (zone: string) => (zone.split('/').at(-1) ?? zone).replace(/_/g, ' ');

/** When the digests arrive, while some label puts its mail in one. Saving it takes this browser's time zone too. */
function DigestRow({ state, reload }: { state: ManageState; reload: () => void }) {
  const { busy, error, run } = useAction();
  const digesting = state.labels.filter((label) => label.disposition === 'digest').map((label) => label.name);
  if (digesting.length === 0) return null;
  const primary = state.accounts.find((a) => a.primary)?.email ?? state.accounts[0]?.email;
  return (
    <SettingRow
      title="Daily digest"
      note={
        <>
          One email each for {digesting.join(', ')}, in {primary}, on {placeOf(state.digest.timeZone ?? 'UTC')} time.
          <Failure>{error}</Failure>
        </>
      }
    >
      <Select
        label="Digest time"
        value={String(state.digest.hour)}
        options={HOURS}
        disabled={busy}
        onChange={(hour) => run(() => api.setDigestTime(Number(hour)), reload)}
      />
    </SettingRow>
  );
}

/** Change the provider: choose, sign in, try a model, switch. Until the switch, the one in use goes on classifying. */
function ChangeProvider({ state, reload, onClose }: { state: ManageState; reload: () => void; onClose: () => void }) {
  const { choices, chosen } = state.model;
  const inUse = chosen?.split('/')[0] ?? null;
  const [picked, setPicked] = useState<(typeof choices)[number] | null>(null);
  const subtitle = `${providerName(
    choices.find((c) => c.provider === inUse),
    inUse ?? '',
  )} stays in use until you switch.`;
  if (!picked)
    return (
      <Dialog open onClose={onClose} title="Change provider" subtitle={subtitle}>
        <ProviderList choices={choices} inUse={inUse} onChoose={setPicked} />
      </Dialog>
    );
  return <Switch key={picked.provider} choice={picked} state={state} reload={reload} subtitle={subtitle} onBack={() => setPicked(null)} onClose={onClose} />;
}

function Switch({
  choice,
  state,
  reload,
  subtitle,
  onBack,
  onClose,
}: {
  choice: ManageState['model']['choices'][number];
  state: ManageState;
  reload: () => void;
  subtitle: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const step = useProviderConnect(choice, state.model, reload);
  const { ready, next } = step;
  const { busy, error, run } = useAction();
  const toast = useToast();
  const old = state.model.chosen?.split('/')[0] ?? null;
  const name = providerName(choice, choice.provider);
  const doSwitch = () =>
    run(async () => {
      if (!ready) return;
      // The new model first, so something always classifies; the old sign-in goes once nothing uses it.
      await api.setModel(ready);
      if (old && old !== choice.provider) await api.signOutModel(old);
      toast(`Now classifying with ${name}`);
      reload();
      onClose();
    });
  return (
    <Dialog
      open
      onClose={onClose}
      title={step.title}
      subtitle={subtitle}
      footer={
        <>
          {next ? (
            <Button
              variant="ink"
              busy={next.busy ?? false}
              onClick={next.onPress}
              {...(next.href !== undefined && !next.disabled ? { href: next.href, target: '_blank', rel: 'noreferrer' } : { disabled: next.disabled ?? false })}
            >
              {next.label}
            </Button>
          ) : (
            <Button variant="ink" busy={busy} disabled={!ready} onClick={doSwitch}>
              Switch to {name}
            </Button>
          )}
          <Button variant="quiet" onClick={onBack}>
            Back
          </Button>
          <Failure>{error}</Failure>
        </>
      }
    >
      {step.body}
    </Dialog>
  );
}

/** The reader's own way to a model and which one classifies their mail: each person signs in for themselves. */
function Model({ state, reload, onConnect }: { state: ManageState; reload: () => void; onConnect: () => void }) {
  const { busy, error, run, settle } = useAction();
  const { chosen, choices, signedIn } = state.model;
  const [changing, setChanging] = useState(false);
  const models = useLoaded(`models ${signedIn.join(' ')}`, (signal) => api.models(signal), 300_000);
  const month = useLoaded('summary-30', (signal) => api.summary(30, signal), 300_000);
  const provider = chosen?.split('/')[0] ?? null;
  const choice = choices.find((c) => c.provider === provider);
  // Connecting a model is SetUp's Connect step, under this panel: the button closes the panel onto it.
  if (chosen === null || provider === null || !signedIn.includes(provider))
    return (
      <SettingsGroup title="Model" note="Classifies what no rule covers.">
        <Sheet>
          <SettingRow title="No model connected" note="Nothing new is classified or suggested. Rules still label what they cover.">
            <Button onClick={onConnect}>Connect a model</Button>
          </SettingRow>
        </Sheet>
      </SettingsGroup>
    );
  const offered = [...new Set([chosen, ...(models.data?.models ?? []).filter((m) => m.startsWith(`${provider}/`))])];
  const others = signedIn.filter((p) => p !== provider);
  const spent = month.data?.totals;
  return (
    <SettingsGroup
      title="Model"
      note={
        spent && spent.costUsd > 0
          ? `Classifies what no rule covers. ${spentLine(spent.costUsd, spent.judged, subscription(state.model))}`
          : 'Classifies what no rule covers.'
      }
    >
      <Sheet>
        <SettingRow title={providerName(choice, provider)} note={choice?.how === 'key' ? 'Key saved.' : 'Signed in.'}>
          <Button onClick={() => setChanging(true)}>Change provider</Button>
        </SettingRow>
        <SettingRow title="Model" note={costLine(choice, models.data?.costs ?? {}, chosen)}>
          <Select
            label="Model"
            value={chosen}
            options={offered.map((m) => [m, m.slice(provider.length + 1)] as const)}
            disabled={busy}
            onChange={(model) => run(() => api.setModel(model), reload)}
          />
        </SettingRow>
        <SettingRow title="Reasoning" note="How long it thinks before it answers. Higher is slower, and each message takes more tokens.">
          <ChoiceGroup
            label="Reasoning"
            value={state.model.reasoning}
            options={REASONING}
            disabled={busy}
            onChange={(reasoning) => reasoning && run(() => api.setReasoning(reasoning), reload)}
          />
        </SettingRow>
        {others.map((p) => (
          <SettingRow
            key={p}
            title={providerName(
              choices.find((c) => c.provider === p),
              p,
            )}
            note="Signed in, but not in use."
          >
            <DeleteButton
              question={`Remove ${providerName(
                choices.find((c) => c.provider === p),
                p,
              )}?`}
              {...(choices.find((c) => c.provider === p)?.how === 'key' ? { says: 'The key you saved goes with it.' } : {})}
              onDelete={async () => {
                await settle(() => api.signOutModel(p));
                reload();
              }}
            >
              Remove
            </DeleteButton>
          </SettingRow>
        ))}
      </Sheet>
      <Failure>{error}</Failure>
      {changing ? <ChangeProvider state={state} reload={reload} onClose={() => setChanging(false)} /> : null}
    </SettingsGroup>
  );
}

/**
 * A person's only mailbox is how they sign in, so it is never removed on its own: that is deleting the
 * account. Removing the one they are signed in as, with others left, ends their session.
 */
function RemoveMailbox({
  email,
  signedIn,
  last,
  onRemoved,
}: {
  email: string;
  signedIn: boolean;
  last: boolean;
  onRemoved: (notRevoked: string | null) => void;
}) {
  const { settle } = useAction();
  return (
    <DeleteButton
      question={`Remove ${email}?`}
      action="Remove mailbox"
      typed={email}
      icon={<Trash2Icon aria-hidden />}
      disabled={last}
      {...(last ? { why: 'You cannot delete your only remaining mailbox.' } : {})}
      says={
        <>
          Sift stops reading it, revokes its access at Google, and deletes everything it recorded about its mail: decisions and answers. Your labels and rules
          stay, for your other mailboxes.
          {signedIn ? ' You are signed in as it, so you will be signed out.' : ''}
          {FILTERS_STAY}
        </>
      }
      onDelete={() => settle(() => removed(api.removeMailbox(email), onRemoved))}
    >
      Remove
    </DeleteButton>
  );
}

function Mailboxes({ state, signedInAs, reload }: { state: ManageState; signedInAs: string | null; reload: () => void }) {
  // Kept on the page, not in a toast: it asks the reader to do something at Google, and a toast would go before it was done.
  const [notRevoked, setNotRevoked] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const primary = state.accounts.find((a) => a.primary)?.email;
  // Google's return, when adding one did not work out.
  const [failed] = useParam('signin');
  return (
    <SettingsGroup title="Mailboxes" note="Anyone signed in as one of these sees all of them.">
      <Sheet>
        {state.accounts.map((account) => (
          <SettingRow
            key={account.id}
            title={account.email}
            note={
              <>
                {account.lastSyncedAt ? (
                  <>
                    Synced <Ago at={account.lastSyncedAt} />
                  </>
                ) : (
                  'Not synced yet'
                )}
                {account.email === signedInAs ? ' · Signed in as this one' : ''}
              </>
            }
          >
            <RemoveMailbox
              email={account.email}
              signedIn={account.email === signedInAs}
              last={state.accounts.length === 1}
              onRemoved={(note) => {
                setNotRevoked(note);
                reload();
              }}
            />
          </SettingRow>
        ))}
        <SettingRow title="Another Gmail account" note={failed ? <Failure>{failed}</Failure> : undefined}>
          <Button href="/auth/login?add=1">Connect</Button>
        </SettingRow>
      </Sheet>
      {state.accounts.length > 1 && primary ? (
        <Sheet>
          <SettingRow
            title="Primary mailbox"
            note={
              <>
                Your account goes by it, whichever one you sign in with. If it is removed, the one connected longest takes its place.
                <Failure>{error}</Failure>
              </>
            }
          >
            <Select
              label="Primary mailbox"
              value={primary}
              options={state.accounts.map((a) => [a.email, a.email] as const)}
              disabled={busy}
              onChange={(email) => run(() => api.makePrimary(email), reload)}
            />
          </SettingRow>
        </Sheet>
      ) : null}
      {notRevoked ? (
        <Note tone="failure" title="Sift still has access at Google">
          <p>{notRevoked}</p>
        </Note>
      ) : null}
    </SettingsGroup>
  );
}

/** Said after a removal when Google could not be reached: sift's access there stays until they take it away. */
const notRevoked = (reply: Removed) =>
  reply.notRevoked.length === 0
    ? null
    : `Google could not be reached, so ${reply.notRevoked.join(' and ')} still lists Sift as having access. Remove it under Third-party connections in your Google Account.`;

/** Said under what a removal deletes: Sift does not take its Gmail filters or labels with it. */
const FILTERS_STAY =
  ' The filters Sift made in Gmail stay there, as do its labels on your mail; delete the filters in Gmail’s settings if you no longer want them.';

/** A mailbox or the account gone: off to the start when that ended the session, else what Google could not be told. */
async function removed(sent: Promise<Removed>, onDone?: (notRevoked: string | null) => void): Promise<void> {
  const reply = await sent;
  const note = notRevoked(reply);
  // Never settles, so nothing is fetched again with the session just ended while the page leaves.
  if (reply.signedOut) return new Promise<never>(() => window.location.assign(note ? `/?signin=${encodeURIComponent(note)}` : '/'));
  onDone?.(note);
}

function Account({ state, signedInAs }: { state: ManageState; signedInAs: string | null }) {
  const { settle } = useAction();
  const email = state.accounts.find((a) => a.primary)?.email ?? signedInAs ?? state.accounts[0]?.email ?? '';
  return (
    <SettingsGroup title="Your account">
      <Sheet>
        <SettingRow
          title="Delete your account"
          note={`Sift stops reading every mailbox, and everything it recorded is deleted.${state.owner ? ' Others signed in to this Sift keep theirs.' : ''}`}
        >
          <DeleteButton
            question="Delete your account?"
            action="Delete everything"
            typed={email}
            says={
              <>
                Sift stops reading every mailbox, revokes its access at Google, and deletes everything it recorded: decisions, answers, rules, labels and your
                model sign-in.{FILTERS_STAY}
              </>
            }
            onDelete={() => settle(() => removed(api.deleteAccount(email)))}
          >
            Delete account
          </DeleteButton>
        </SettingRow>
      </Sheet>
    </SettingsGroup>
  );
}

/** Kept in this browser, not in sift: it is about how this reader works, not how mail is classified. */
function Keys() {
  const on = useShortcutsOn();
  return (
    <SettingsGroup title="This browser" note="Kept here, not in Sift.">
      <Sheet>
        <SettingRow
          title="Keyboard shortcuts"
          note={
            <>
              <Kbd>?</Kbd> lists the ones that work where you are.
            </>
          }
        >
          <Button onClick={() => setShortcutsOn(!on)}>{on ? 'Turn off' : 'Turn on'}</Button>
        </SettingRow>
      </Sheet>
    </SettingsGroup>
  );
}

/** How sift runs, most used first. What it does with mail is under Labels and Rules. */
/** Settings, over whatever is showing. Opened from the account menu, or from the setting-up page, so nothing has to be set up first. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { data, error, loading, reload } = useLoaded('manage', (signal) => api.manage(signal), 10_000);
  const session = useLoaded('session', (signal) => api.session(signal), 300_000);
  const signedInAs = session.data?.email ?? null;
  return (
    <Panel open onClose={onClose} title="Settings">
      <div className="flex flex-col gap-10">
        {error ? <ErrorNote message={error} /> : null}
        {loading ? (
          <Loading rows={6} />
        ) : data ? (
          <>
            {/* Whether sift is on, the model and its sign-in are each person's own. */}
            <Active state={data} reload={reload} />
            <Mail state={data} reload={reload} />
            <Model state={data} reload={reload} onConnect={onClose} />
            <Mailboxes state={data} signedInAs={signedInAs} reload={reload} />
            <Keys />
            <Account state={data} signedInAs={signedInAs} />
          </>
        ) : null}
      </div>
    </Panel>
  );
}
