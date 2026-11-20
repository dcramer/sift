import { z } from 'zod';
import { listAccounts } from '../../../../../store/accounts.ts';
import { preferences } from '../../../../../store/preferences.ts';
import { MailAsk } from '../../../../types.ts';
import { self, write } from '../../../route.ts';
import { Refusal } from '../../../../../refusal.ts';

/** Ask the person's model to turn their words into a filter on Inbox's list. Nothing is narrowed: the page shows the filter. */
export default write({
  path: '/api/mail/ask',
  body: z.strictObject({ words: z.string().trim().min(1).max(500), today: z.iso.date() }),
  reply: MailAsk,
  touches: self,
  run: async ({ db, controls }, { words, today }) => {
    const [target] = await listAccounts(db);
    if (!target) return null;
    if (!(await preferences(db)).mail) throw new Refusal('Turn Inbox on first.');
    if (!controls) throw new Refusal('This dashboard cannot run the model.');
    return await controls.askMail(db, { accountId: target.id, words, today });
  },
});
