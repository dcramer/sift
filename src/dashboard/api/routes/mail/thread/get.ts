import { z } from 'zod';
import { conversation } from '../../../../queries/mail.ts';
import { MailConversation } from '../../../../types.ts';
import { missing, ok, read } from '../../../route.ts';

export default read({
  path: '/api/mail/thread',
  query: z.object({ thread: z.string().default('') }),
  reply: MailConversation,
  run: async ({ db }, scope, { thread }) => {
    const found = await conversation(db, scope, thread);
    return found ? ok(found) : missing('No such conversation');
  },
});
