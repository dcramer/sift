import { z } from 'zod';
import { Refusal } from '../../../../../refusal.ts';
import { replyTo } from '../../../../queries/reply.ts';
import { SendRequest } from '../../../../types.ts';
import { named, write } from '../../../route.ts';

export default write({
  path: '/api/mail/send',
  body: SendRequest,
  reply: z.object({ id: z.string(), threadId: z.string() }),
  touches: named,
  run: async ({ db, controls }, { accountId, id, from, to, cc, text, ...about }, scope) => {
    if (!controls) throw new Refusal('This dashboard cannot send mail.');
    const mail = { from, to, cc, text };
    if ('subject' in about) return await controls.send(db, { accountId, id, mail: { ...mail, subject: about.subject } });
    const answered = await replyTo(db, scope, accountId, about.replyTo.messageId);
    if (!answered) return null;
    const { threadId, ...thread } = answered;
    return await controls.send(db, { accountId, id, threadId, mail: { ...mail, ...thread } });
  },
});
