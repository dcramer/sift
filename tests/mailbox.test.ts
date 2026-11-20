import { describe, expect, it } from 'vitest';
import { connectGmail, fakeGoogle } from './fixtures.ts';
import type { FakeGmail } from './google.ts';

const fake = fakeGoogle();

const labelCalls = (gmail: FakeGmail) => gmail.requests.map((r) => r.method).filter((m) => m.startsWith('users.labels.'));

describe('ensureLabel', () => {
  it('uses a label whose case was changed in Gmail instead of making it again', async () => {
    const { mailbox, gmail } = connectGmail(fake.google);
    const renamed = gmail.label('Sift/News');
    expect(await mailbox.ensureLabel('sift/news')).toBe(renamed);
    expect(labelCalls(gmail)).toEqual(['users.labels.list']);
  });

  it('uses a label made since it read the list', async () => {
    const { mailbox, gmail } = connectGmail(fake.google);
    expect(await mailbox.ensureLabel('sift/other')).toBe(gmail.labelId('sift/other'));
    const made = gmail.label('sift/did/archived');
    expect(await mailbox.ensureLabel('sift/did/archived')).toBe(made);
    expect(labelCalls(gmail)).toEqual(['users.labels.list', 'users.labels.create', 'users.labels.create', 'users.labels.list']);
  });
});
