import { z } from 'zod';
import { listContacts } from '../../../queries/contacts.ts';
import { ContactPage, Given } from '../../../types.ts';
import { ok, read } from '../../route.ts';

export default read({
  path: '/api/contacts',
  query: z.object({
    q: z.string().max(200).optional(),
    standing: Given.optional().catch(undefined),
    know: z.enum(['new', 'mutual', 'one-way']).optional().catch(undefined),
    limit: z.coerce.number().int().positive().max(200).catch(50),
    offset: z.coerce.number().int().nonnegative().catch(0),
  }),
  reply: ContactPage,
  run: async ({ db, now }, scope, { q, standing, know, limit, offset }) =>
    ok(await listContacts(db, scope, { ...(q ? { search: q } : {}), ...(standing ? { standing } : {}), ...(know ? { know } : {}), limit, offset }, now())),
});
