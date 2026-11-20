import { press, undo } from '../actions/executor.ts';
import { removeRuleFilter, writeRuleFilter } from '../actions/rule-filters.ts';
import { sendMail } from '../actions/send.ts';
import type { Config } from '../config.ts';
import { type Ephemeral, holding } from '../ephemeral/ephemeral.ts';
import type { Controls } from '../dashboard/controls.ts';
import { forgetPassStatus, passStatus } from '../work/status.ts';
import { REACH, modelShare } from '../store/inbox.ts';
import { averageCall } from '../store/runs.ts';
import { hasOwnLabels } from '../store/labels.ts';
import { EXAMPLES as RULE_EXAMPLES, ruleInbox } from '../work/apply.ts';
import { reachOf } from '../work/copy.ts';
import { keptSize } from '../store/kept.ts';
import { MAIL_WINDOWS } from '../mail-window.ts';
import { createGmailApi } from '../gmail/api.ts';
import { startEval } from '../learn/evals.ts';
import { proposeLabels } from '../learn/labels.ts';
import { draftRule } from '../learn/rules.ts';
import { askMail } from '../learn/mail.ts';
import { clientFor, loadClientSecrets, revokeGrant } from '../gmail/auth.ts';
import { createGmailMailbox } from '../gmail/mailbox.ts';
import { pacer } from '../gmail/quota.ts';
import { chatgptPending, checkChatGPT, finishChatGPT, forgetChatGPT, startChatGPT } from './chatgpt.ts';
import type { SignIns } from '../model/credentials.ts';
import { createJudge } from '../model/judge.ts';
import { createHighlighter } from '../model/digest.ts';
import { createProposer } from '../model/propose.ts';
import { createRuleDrafter } from '../model/draft-rule.ts';
import { createMailAsker } from '../model/ask.ts';
import { type ChosenModel, modelChoices, offerModel, openModels, priceOf, resolveModel, saveApiKey, shortlistModels } from '../model/models.ts';
import { listAccounts, personOf } from '../store/accounts.ts';
import { getAction, lastStandingChange } from '../store/actions.ts';
import { hashOf } from '../store/content.ts';
import { credentials } from '../store/credentials.ts';
import { recordLabels } from '../store/messages.ts';
import { preferences } from '../store/preferences.ts';
import type { Sql } from '../store/sql.ts';
import { Refusal } from '../refusal.ts';
import { reportError } from '../telemetry.ts';
import type { StandIns } from './sift.ts';
import { seal } from '../plain.ts';

const DAY_MS = 86_400_000;
/** How far back an estimate looks for how much mail went to the model: recent enough to reflect the rules as they are. */
const ESTIMATE_DAYS = 30;
/** What a message's text and HTML take to keep, in bytes, for someone whose own mail does not say yet: a guess. */
const KEPT_GUESS = 30_000;
/**
 * How long a count only Gmail knows is kept: the settings, a rule's look at the inbox and setting up open with one, so a reload
 * or a second look asks Gmail nothing for a while.
 */
const COUNT_MS = 5 * 60_000;

/** A Gmail client for one of the person's mailboxes, with the sign-in kept in their database. */
async function gmailClient(config: Config, db: Sql, email: string) {
  const token = await (await credentials(db, 'gmail')).read(email);
  if (token === null) throw new Refusal(`Sift has no access to ${email}. Sign in to the dashboard with that account.`);
  return clientFor(loadClientSecrets(config), token);
}

/** Gmail for one of the person's mailboxes, with the sign-in kept in their database, each call paced under the mailbox's quota. */
export async function gmailFor(config: Config, ephemeral: Ephemeral, db: Sql, email: string) {
  const client = await gmailClient(config, db, email);
  const pace = pacer(ephemeral, email);
  return { client, pace, api: createGmailApi(client, pace), mailbox: createGmailMailbox(client, pace) };
}

/** One person's model sign-ins, kept in their database and changed by one process at a time. */
async function modelSignIns(ephemeral: Ephemeral, db: Sql): Promise<SignIns> {
  const person = await personOf(db);
  return { ...(await credentials(db, 'model')), exclusive: (work) => holding(ephemeral, `lock:signin:${person}`, work) };
}

/** One person's model providers, signed in with what is kept in their database. */
const modelsFor = async (config: Config, ephemeral: Ephemeral, db: Sql) =>
  openModels(await modelSignIns(ephemeral, db), config.settings.chatgptSignIn ?? 'device-code');

/**
 * The model tier of the person whose database `db` is, from their own choice and sign-in.
 * Null when they have chosen no model. Throws, with what to do, when they have chosen one they cannot reach.
 */
async function openModel(config: Config, ephemeral: Ephemeral, db: Sql): Promise<ChosenModel | null> {
  const { model: spec, reasoning } = await preferences(db);
  if (!spec) return null;
  const models = await modelsFor(config, ephemeral, db);
  const model = resolveModel(models, spec);
  if (!(await models.getAuth(model))) throw new Refusal(`Not signed in to ${model.provider}. Sign in under Settings in the dashboard.`);
  return { spec, models, model, reasoning };
}

export async function openModelTier(config: Config, ephemeral: Ephemeral, db: Sql) {
  const opened = await openModel(config, ephemeral, db);
  return (
    opened && {
      spec: opened.spec,
      judge: createJudge(opened.models, opened.model, opened.reasoning),
      highlight: createHighlighter(opened.models, opened.model, opened.reasoning),
    }
  );
}

/** What the dashboard may ask this process to do. See `Controls`. */
export async function buildControls(
  config: Config,
  live: { ephemeral: Ephemeral; deviceId: string; kick: (person: number) => Promise<void>; standIns?: StandIns },
): Promise<Controls> {
  const choices = modelChoices(config.settings.chatgptSignIn ?? 'device-code');
  /** Begin what is due for the person now, not at the next tick. */
  const passNow = async (db: Sql) => live.kick(await personOf(db));
  const { standIns } = live;
  /** A count only Gmail knows, kept in `Ephemeral` for `COUNT_MS` under `key`, which names a mailbox by its number. */
  const counted = async <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const kept = await live.ephemeral.get<T>(key);
    if (kept !== null) return kept;
    const value = await ask();
    await live.ephemeral.set(key, value, COUNT_MS);
    return value;
  };
  const gmail = async (db: Sql, email: string) => await gmailFor(config, live.ephemeral, db, email);
  const chosen = async (db: Sql) => standIns?.model ?? (await openModel(config, live.ephemeral, db));
  /** The size of the person's own calls lately, in tokens, which is their mail and their labels more than the model; undefined for a typical call's. */
  const usualCall = async (db: Sql) => {
    const usual = await averageCall(db);
    return usual ? { input: usual.inputTokens, output: usual.outputTokens } : undefined;
  };
  /**
   * What classifying one message costs the person on their model, in dollars: what their calls on it have cost
   * lately, else their usual call at its catalog price. Through ChatGPT, what the same use would cost through
   * the API. Null when they have no model or its price is not known.
   */
  const costEach = async (db: Sql) => {
    const { model: spec } = await preferences(db);
    if (!spec) return null;
    return (await averageCall(db, spec))?.costUsd ?? priceOf(resolveModel(await modelsFor(config, live.ephemeral, db), spec).cost, await usualCall(db));
  };
  return {
    models: async (db) => {
      const available = (await (await modelsFor(config, live.ephemeral, db)).getAvailable()).filter((m) => offerModel(m.provider, m.id));
      const shortlist: Record<string, string[]> = {};
      for (const provider of new Set(available.map((m) => m.provider))) {
        const ids = shortlistModels(
          provider,
          available.filter((m) => m.provider === provider).map((m) => m.id),
        );
        if (ids.length > 0) shortlist[provider] = ids.map((id) => `${provider}/${id}`);
      }
      // Each priced for the same calls, so they compare.
      const tokens = await usualCall(db);
      const costs: Record<string, number> = {};
      for (const m of available) {
        const each = priceOf(m.cost, tokens);
        if (each !== null) costs[`${m.provider}/${m.id}`] = each * 1000;
      }
      return { models: available.map((m) => `${m.provider}/${m.id}`), shortlist, costs };
    },
    modelSignIns: async (db) => {
      const person = await personOf(db);
      const signIns = await modelSignIns(live.ephemeral, db);
      // Signed in just now: their mail has a model to go to.
      if ((await checkChatGPT(live.ephemeral, person, signIns)) === 'done') await passNow(db);
      return { choices: choices.map((c) => ({ ...c })), signedIn: await signIns.keys(), pending: await chatgptPending(live.ephemeral, person) };
    },
    signInChatGPT: async (db) => {
      const person = await personOf(db);
      const how = choices[0]!.how === 'redirect' ? 'redirect' : 'device-code';
      return await startChatGPT(live.ephemeral, person, how, live.deviceId);
    },
    finishChatGPT: async (db, address) => {
      await finishChatGPT(live.ephemeral, await personOf(db), await modelSignIns(live.ephemeral, db), address);
      await passNow(db);
    },
    saveModelKey: async (db, provider, key) => {
      if (!choices.some((c) => c.provider === provider && c.how === 'key')) throw new Refusal('That provider does not take an API key.');
      await saveApiKey(await modelSignIns(live.ephemeral, db), provider, key);
      await passNow(db);
    },
    signOutModel: async (db, provider) => {
      await (await modelSignIns(live.ephemeral, db)).remove(provider);
      await forgetChatGPT(live.ephemeral, await personOf(db));
    },
    undo: async (db, actionId) => {
      const action = await getAction(db, actionId);
      if (!action) throw new Refusal(`There is no change #${actionId}.`);
      const outcome = await undo({ db, mailbox: (await gmail(db, action.accountId)).mailbox }, actionId);
      if (outcome.status === 'done') {
        await recordLabels(db, action.accountId, action.messageId, outcome.finalLabels);
        return null;
      }
      if (outcome.status === 'skipped') return 'Already put back by hand';
      throw new Refusal(outcome.reason);
    },
    changeMail: async (db, accountId, messageIds, change) => {
      const deps = { db, mailbox: (await gmail(db, accountId)).mailbox };
      const landed: number[] = [];
      let missed = 0;
      for (const messageId of messageIds) {
        try {
          const { outcome, labels } = await press(deps, accountId, messageId, change);
          if (labels) await recordLabels(db, accountId, messageId, labels);
          // A change whose answer was lost may have landed: Undo is offered, and settles it from Gmail first.
          if (outcome.status === 'done' || outcome.status === 'unknown') landed.push(outcome.actionId);
          else if (outcome.status !== 'skipped') missed++;
        } catch (error) {
          reportError(error);
          missed++;
        }
      }
      return { actions: landed, missed };
    },
    inboxEstimate: async (db, mailboxes, reach) => {
      let messages = 0;
      for (const account of await listAccounts(db)) {
        if (!mailboxes.includes(account.id) || !(await hasOwnLabels(db))) continue;
        const size = await counted(`count:inbox:${account.number}`, async () => await (await gmail(db, account.id)).api.inboxSize());
        messages += Math.min(size, REACH[reach]);
      }
      // As much of it as went to the model lately; with nothing to go by, all of it.
      const model = Math.round(messages * ((await modelShare(db, Date.now() - ESTIMATE_DAYS * DAY_MS)) ?? 1));
      const each = await costEach(db);
      return { messages, model, cost: each === null ? null : model * each };
    },
    mailReach: async (db, mailboxes) => {
      const reach = {
        year: { messages: 0, bytes: 0, minutes: 0 },
        three_years: { messages: 0, bytes: 0, minutes: 0 },
        all: { messages: 0, bytes: 0, minutes: 0 },
      };
      const each = (await keptSize(db)) ?? KEPT_GUESS;
      for (const account of await listAccounts(db)) {
        if (!mailboxes.includes(account.id) || !(await hasOwnLabels(db))) continue;
        const mailbox = await counted(`count:reach:${account.number}`, async () => await reachOf((await gmail(db, account.id)).api, Date.now()));
        for (const window of MAIL_WINDOWS) {
          reach[window].messages += mailbox[window].messages;
          reach[window].bytes += Math.round(mailbox[window].messages * each);
          // Each mailbox has a quota of its own, and its copy a run of its own, so they go side by side.
          reach[window].minutes = Math.max(reach[window].minutes, mailbox[window].minutes);
        }
      }
      return reach;
    },
    putBack: async (db, accountId, messageId) => {
      const last = await lastStandingChange(db, accountId, messageId);
      const outcome = last ? await undo({ db, mailbox: (await gmail(db, accountId)).mailbox }, last.id) : null;
      // The corrected decision is waiting to be carried out; do it now, not at the next interval.
      await passNow(db);
      if (outcome?.status === 'failed' || outcome?.status === 'unknown') throw new Refusal(outcome.reason);
    },
    startEval: async (db, request) => {
      const tier = await openModelTier(config, live.ephemeral, db);
      if (!tier) throw new Refusal('Choose a model first.');
      const run = await startEval({ db, model: tier.spec }, request);
      await passNow(db);
      return run;
    },
    proposeLabels: async (db, request) => {
      const opened = await chosen(db);
      if (!opened) throw new Refusal('Choose a model first.');
      return seal(await proposeLabels({ db, propose: createProposer(opened.models, opened.model, opened.reasoning), model: opened.spec }, request));
    },
    draftRule: async (db, request) => {
      const opened = await chosen(db);
      if (!opened) throw new Refusal('Choose a model first.');
      return seal(await draftRule({ db, draft: createRuleDrafter(opened.models, opened.model, opened.reasoning), model: opened.spec }, request));
    },
    askMail: async (db, request) => {
      const opened = await chosen(db);
      if (!opened) throw new Refusal('Choose a model first.');
      return seal(await askMail({ db, ask: createMailAsker(opened.models, opened.model, opened.reasoning), model: opened.spec }, request));
    },
    ruleFilter: async (db, ruleId, on) => {
      // Every mailbox is tried, so one Gmail refusing does not leave the others as they were.
      let failed: unknown;
      for (const account of await listAccounts(db)) {
        const deps = { db, mailbox: (await gmail(db, account.id)).mailbox };
        await (on ? writeRuleFilter(deps, ruleId, account.id) : removeRuleFilter(deps, ruleId, account.id)).catch((error: unknown) => {
          failed ??= error;
        });
      }
      if (failed !== undefined) throw failed;
    },
    ruleInbox: async (db, ruleId) => {
      const samples = [];
      for (const account of await listAccounts(db)) {
        const { api } = await gmail(db, account.id);
        // The search is the look's one call to Gmail once what it found is recorded; the query names senders, so its key is a keyed hash.
        const searchInbox: typeof api.searchInbox = async (query) =>
          await counted(`count:rule:${account.number}:${hashOf(db, query)}`, () => api.searchInbox(query));
        const sample = await ruleInbox(db, { ...api, searchInbox }, account.id, ruleId);
        samples.push({ ...sample, examples: sample.examples.map((m) => ({ accountId: account.id, ...m, subject: seal(m.subject) })) });
      }
      const capped = samples.some((s) => s.most !== null);
      return {
        examples: samples
          .flatMap((s) => s.examples)
          .toSorted((a, b) => b.receivedAt - a.receivedAt)
          .slice(0, RULE_EXAMPLES),
        messages: samples.reduce((n, s) => n + s.messages, 0),
        reading: samples.reduce((n, s) => n + s.reading, 0),
        exact: samples.every((s) => s.exact),
        most: capped ? samples.reduce((n, s) => n + (s.most ?? s.messages), 0) : null,
        costEach: await costEach(db),
      };
    },
    revokeGmail: async (db, email) => {
      await forgetPassStatus(live.ephemeral, email);
      // A token that no longer opens (the key changed) cannot be revoked from here, and must not stop the removal.
      const token = await (await credentials(db, 'gmail')).read(email).catch(() => undefined);
      return token === null || (token !== undefined && (await revokeGrant(token)));
    },
    send: async (db, sending) => await sendMail({ db, mailbox: (await gmail(db, sending.accountId)).mailbox }, sending),
    checkNow: passNow,
    activity: async (mailboxes) => ({ running: true, ...(await passStatus(live.ephemeral, mailboxes)) }),
  };
}
