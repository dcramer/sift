import { z } from 'zod';
import { MailReach } from '../../../../types.ts';
import { ok, read } from '../../../route.ts';
import { Refusal } from '../../../../../refusal.ts';

export default read({
  path: '/api/mail/reach',
  query: z.object({}),
  reply: MailReach,
  run: async ({ db, controls }, scope) => {
    if (!controls) throw new Refusal('This dashboard cannot read Gmail.');
    return ok(await controls.mailReach(db, scope.accounts));
  },
});
