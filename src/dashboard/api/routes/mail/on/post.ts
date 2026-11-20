import { z } from 'zod';
import { setMail } from '../../../../../store/preferences.ts';
import { MailWindow } from '../../../../types.ts';
import { done, self, write } from '../../../route.ts';

export default write({
  path: '/api/mail/on',
  // `window` on, or while on: how far back the copy goes. Wider starts copying what it adds; narrower lets go of what falls outside.
  body: z.strictObject({ on: z.boolean(), window: MailWindow.optional() }),
  reply: done,
  touches: self,
  run: async ({ db, controls, now }, { on, window }) => {
    await setMail(db, on, { now: now(), ...(window ? { window } : {}) });
    // Its copies and passes read the mail.
    if (on) await controls?.checkNow(db);
    return { ok: true as const };
  },
});
