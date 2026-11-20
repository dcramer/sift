import { z } from 'zod';
import { canSend, lastSyncedAt, listAccounts, mailboxAliases, signInEnds } from '../../../../store/accounts.ts';
import { inboxProgress } from '../../../../store/inbox.ts';
import { copyProgress } from '../../../../store/copies.ts';
import { MAX_LABELS } from '../../../../store/labels.ts';
import { waitingCount } from '../../../../learn/feedback.ts';
import { preferences } from '../../../../store/preferences.ts';
import { listLabelSummaries } from '../../../queries/labels.ts';
import { type Scope, sees } from '../../../scope.ts';
import { ManageState } from '../../../types.ts';
import { type Context, ok, read } from '../../route.ts';

/** Everything the Settings screen shows, for the mailboxes in scope. */
async function manageState({ db, controls, person }: Context, scope: Scope): Promise<ManageState> {
  const accounts = (await listAccounts(db)).filter((a) => sees(scope, a.id));
  const own = await preferences(db);
  const ends = await signInEnds(db);
  const activity = controls ? await controls.activity(accounts.map((a) => a.id)) : { running: false, lastPassAt: null, problems: [], expired: [] };
  return {
    owner: scope.owner,
    active: own.active,
    mail: own.mail,
    mailWindow: own.mailWindow,
    copying: (
      await copyProgress(
        db,
        accounts.map((a) => a.id),
      )
    ).going,
    model: { chosen: own.model, reasoning: own.reasoning, ...(controls ? await controls.modelSignIns(db) : { choices: [], signedIn: [], pending: null }) },
    activity: {
      ...activity,
      // Only these mailboxes were asked about; checked again here, since a leak would be someone else's mail.
      problems: activity.problems.filter((line) => accounts.some((a) => line.startsWith(`${a.email}: `))),
      expired: activity.expired.filter((email) => accounts.some((a) => a.email === email)),
    },
    accounts: await Promise.all(
      accounts.map(async (a) => ({
        id: a.id,
        email: a.email,
        lastSyncedAt: await lastSyncedAt(db, a.id),
        primary: a.id === person?.primary,
        canSend: await canSend(db, a.id),
        aliases: await mailboxAliases(db, a.id),
        signInEnds: ends.get(a.id) ?? null,
      })),
    ),
    labels: await listLabelSummaries(db, scope),
    labelLimit: MAX_LABELS,
    waiting: await waitingCount(
      db,
      accounts.map((a) => a.id),
    ),
    inbox: await inboxProgress(
      db,
      accounts.map((a) => a.id),
    ),
    digest: { hour: own.digestHour, timeZone: own.timeZone },
  };
}

export default read({ path: '/api/manage', query: z.object({}), reply: ManageState, run: async (ctx, scope) => ok(await manageState(ctx, scope)) });
