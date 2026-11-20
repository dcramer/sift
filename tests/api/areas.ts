import { describe, expect, it } from 'vitest';
import { answeredRoutes } from '../fixtures.ts';

/**
 * Which file under `tests/api/` runs each route of `src/dashboard/api/index.ts` against the whole app, as `METHOD path`.
 * `coverage.test.ts` fails on a registered route that is in none; each file's `everyRouteAnswered` fails on one of its
 * own that no test in it was answered 200 by.
 */
export const AREAS = {
  mail: [
    'GET /api/mail/threads',
    'GET /api/mail/thread',
    'GET /api/mail/reach',
    'POST /api/mail/on',
    'POST /api/mail/change',
    'POST /api/mail/send',
    'POST /api/mail/ask',
    'GET /api/message',
    'GET /api/message/html',
    'POST /api/undo',
  ],
  rules: [
    'GET /api/rules',
    'POST /api/rules',
    'POST /api/rules/edit',
    'POST /api/rules/remove',
    'POST /api/rules/filter',
    'GET /api/rules/inbox',
    'POST /api/rules/apply',
    'GET /api/rules/usage',
    'GET /api/rules/waiting',
    'POST /api/rules/draft',
    'POST /api/proposals',
  ],
  labels: [
    'POST /api/labels/add',
    'POST /api/labels/accept',
    'POST /api/labels',
    'POST /api/labels/remove',
    'POST /api/labels/propose',
    'GET /api/labels/proposal',
  ],
  settings: [
    'GET /api/manage',
    'POST /api/active',
    'POST /api/check',
    'POST /api/digest',
    'POST /api/mailbox/primary',
    'POST /api/mailbox/remove',
    'POST /api/account/delete',
    'GET /api/usage',
    'GET /api/summary',
    'GET /api/inbox',
    'POST /api/inbox/start',
    'POST /api/inbox/stop',
  ],
  model: [
    'GET /api/models',
    'POST /api/model',
    'POST /api/model/key',
    'POST /api/model/reasoning',
    'POST /api/model/signout',
    'POST /api/model/chatgpt',
    'POST /api/model/chatgpt/finish',
  ],
  review: [
    'GET /api/suggestions',
    'GET /api/suggestion',
    'POST /api/feedback',
    'GET /api/decisions',
    'GET /api/examples',
    'POST /api/examples/delete',
    'POST /api/examples/delete-all',
    'GET /api/evals',
    'POST /api/evals/run',
    'GET /api/eval',
  ],
  senders: ['GET /api/sender', 'GET /api/domain', 'GET /api/contacts', 'POST /api/standing', 'POST /api/standing/clear'],
} as const satisfies Record<string, readonly string[]>;

/** Runs last in the file: each of the area's routes was answered 200 by some test above. */
export function everyRouteAnswered(area: keyof typeof AREAS): void {
  describe(`the ${area} routes`, () => {
    it('are each answered 200 by a test above', () => {
      expect(
        AREAS[area].filter((route) => !answeredRoutes.has(route)),
        'test these through a startSift browser',
      ).toEqual([]);
    });
  });
}
