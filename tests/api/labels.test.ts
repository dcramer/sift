import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPOSAL_TOOL } from '../../src/triage/proposal.ts';
import { type Browser, fakeGoogle, fauxModel, startSift } from '../fixtures.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

type Label = { id: string; name: string; disposition: string; markRead: boolean; gmailLabel: string | null; rules: number };
const labelsOf = async (b: Browser) => (await b.call('GET', '/api/manage')).body['labels'] as Label[];
const PITCHES = { why: 'fewer pitches', name: 'Cold outreach', description: 'Pitches from strangers.', action: 'archive', markRead: false, unsubscribe: true };
const BUILDS = {
  why: 'builds only when one fails',
  name: 'Build results',
  description: 'Results of builds.',
  action: 'digest',
  markRead: false,
  unsubscribe: false,
};

describe('setting up labels', () => {
  it('asks the model for labels from what the person wants, keeps its answer, and reads no Gmail until some are made', async () => {
    const model = fauxModel();
    const sift = await startSift(fake.google, { model: model.chosen });
    const box = fake.google.mailbox(ME);
    const me = await sift.signedIn(ME);
    await sift.work();
    model.answers(fauxAssistantMessage([fauxToolCall(PROPOSAL_TOOL, { labels: [PITCHES, BUILDS], note: '' })], { stopReason: 'toolUse' }));

    const proposed = await me.call('POST', '/api/labels/propose', { goal: 'Fewer sales pitches, and builds only when they fail' });
    expect(proposed).toMatchObject({
      status: 200,
      body: {
        drafts: [
          { name: 'Cold outreach', disposition: 'archive', unsubscribe: true },
          { name: 'Build results', disposition: 'digest' },
        ],
      },
    });
    expect((await me.call('GET', '/api/labels/proposal')).body).toMatchObject({ proposal: proposed.body });

    box.deliver({ from: 'ada@example.com' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    expect(box.asked('users.history.list')).toEqual([]);

    const accepted = await me.call('POST', '/api/labels/accept', {
      labels: [
        { name: 'Cold outreach', description: 'Pitches from strangers.', disposition: 'archive', unsubscribe: true },
        { name: 'Build results', description: 'Results of builds.', disposition: 'digest' },
      ],
      timeZone: 'Europe/Paris',
    });
    expect(accepted).toMatchObject({ status: 200, body: { ids: [expect.any(String), expect.any(String)] } });
    expect(await labelsOf(me)).toMatchObject([
      { name: 'Cold outreach', disposition: 'archive' },
      { name: 'Build results', disposition: 'digest' },
      { name: 'Leave in inbox' },
    ]);
    expect((await me.call('GET', '/api/manage')).body).toMatchObject({ digest: { timeZone: 'Europe/Paris' } });
    await sift.work();
    expect(box.asked('users.history.list')).not.toEqual([]);

    expect(await me.call('POST', '/api/labels/accept', { labels: [{ name: 'More', description: 'More.', disposition: 'keep' }] })).toMatchObject({
      status: 409,
      body: { error: 'You have labels already. Change them on the Labels screen.' },
    });
  });

  it('says so when the model suggests nothing usable, and without a model', async () => {
    const model = fauxModel();
    const sift = await startSift(fake.google, { model: model.chosen });
    const me = await sift.signedIn(ME);
    model.answers(fauxAssistantMessage([fauxText('Try a Marketing label.')]));
    expect(await me.call('POST', '/api/labels/propose', { goal: 'Fewer pitches' })).toMatchObject({
      status: 409,
      body: { error: 'The model could not suggest labels (the model did not suggest any usable labels). Try again.' },
    });

    const without = await (await startSift(fake.google)).signedIn(OTHER);
    expect(await without.call('POST', '/api/labels/propose', { goal: 'Fewer pitches' })).toMatchObject({
      status: 409,
      body: { error: 'Choose a model first.' },
    });
  });

  it('shows nobody else the proposal', async () => {
    const model = fauxModel();
    const sift = await startSift(fake.google, { model: model.chosen });
    const me = await sift.signedIn(ME);
    model.answers(fauxAssistantMessage([fauxToolCall(PROPOSAL_TOOL, { labels: [PITCHES], note: '' })], { stopReason: 'toolUse' }));
    await me.call('POST', '/api/labels/propose', { goal: 'Fewer pitches' });
    const other = await sift.signedIn(OTHER);
    expect((await other.call('GET', '/api/labels/proposal')).body).toEqual({ proposal: null });
  });
});

describe('a person’s labels', () => {
  it('are added, all or none, and a digest’s hour is kept in the person’s own zone', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    const added = await me.call('POST', '/api/labels/add', {
      labels: [{ name: 'Updates', description: 'Product updates.', disposition: 'digest' }],
      timeZone: 'America/New_York',
    });
    expect(added).toMatchObject({ status: 200, body: { ids: ['updates'] } });
    expect((await labelsOf(me)).map((l) => l.name)).toEqual(['Receipts', 'Updates', 'Leave in inbox']);
    expect((await me.call('GET', '/api/manage')).body).toMatchObject({ digest: { timeZone: 'America/New_York' } });

    const twice = await me.call('POST', '/api/labels/add', {
      labels: [
        { name: 'Travel', description: 'Trips.', disposition: 'keep' },
        { name: 'Updates', description: 'Again.', disposition: 'archive' },
      ],
    });
    expect(twice.status).toBe(409);
    expect((await labelsOf(me)).map((l) => l.name)).toEqual(['Receipts', 'Updates', 'Leave in inbox']);
  });

  it('change what they do, and what is waiting with them is decided again', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    const me = await sift.settled(ME);
    const id = box.deliver({ from: 'shop@example.com', subject: 'Receipt' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    await sift.judged(ME, id, 'receipts');

    const changed = await me.call('POST', '/api/labels', { id: 'receipts', disposition: 'spam', markRead: false });
    expect(changed).toMatchObject({ status: 200, body: { ok: true, redecided: 1 } });
    expect(await labelsOf(me)).toMatchObject([{ id: 'receipts', disposition: 'spam' }, { id: 'everything_else' }]);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ items: [{ messageId: id, labelId: 'receipts', disposition: 'spam' }] });
    expect(await me.call('POST', '/api/labels', { id: 'nothing', name: 'Nothing' })).toMatchObject({
      status: 409,
      body: { error: 'There is no label "nothing".' },
    });
  });

  it('are removed with their rules and those rules’ Gmail filters, though never the last one or Leave in inbox', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    const me = await sift.settled(ME);
    await me.call('POST', '/api/labels/add', { labels: [{ name: 'Updates', description: 'Product updates.', disposition: 'archive' }] });
    await me.call('POST', '/api/active', { active: true });
    const { id: rule } = (await me.call('POST', '/api/rules', { match: { from: ['news@example.com'] }, label: 'updates' })).body as { id: string };
    await me.call('POST', '/api/rules/filter', { id: rule, on: true });
    expect(box.filters).toHaveLength(1);

    expect(await me.call('POST', '/api/labels/remove', { id: 'updates' })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await labelsOf(me)).map((l) => l.id)).toEqual(['receipts', 'everything_else']);
    expect((await me.call('GET', '/api/rules')).body).toEqual({ rules: [] });
    expect(box.filters).toEqual([]);

    expect((await me.call('POST', '/api/labels/remove', { id: 'receipts' })).status).toBe(409);
    expect((await me.call('POST', '/api/labels/remove', { id: 'everything_else' })).status).toBe(409);
    expect((await labelsOf(me)).map((l) => l.id)).toEqual(['receipts', 'everything_else']);
  });

  it('are each person’s own', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    await me.call('POST', '/api/labels/add', { labels: [{ name: 'Updates', description: 'Product updates.', disposition: 'archive' }] });
    const other = await sift.settled(OTHER);
    expect((await labelsOf(other)).map((l) => l.id)).toEqual(['receipts', 'everything_else']);
    expect((await other.call('POST', '/api/labels/remove', { id: 'updates' })).status).toBe(409);
    expect((await me.call('POST', '/api/labels', { id: 'updates', disposition: 'keep' })).status).toBe(200);
    expect((await other.call('POST', '/api/labels', { id: 'updates', disposition: 'spam' })).status).toBe(409);
    expect(await labelsOf(me)).toMatchObject([{ id: 'receipts' }, { id: 'updates', disposition: 'keep' }, { id: 'everything_else' }]);
  });
});

everyRouteAnswered('labels');
