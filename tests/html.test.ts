import { describe, expect, it } from 'vitest';
import { gatherEvidence } from '../src/work/evidence.ts';
import { readContent } from '../src/gmail/body.ts';
import { recordSync } from '../src/store/accounts.ts';
import { connectGmail, fakeGoogle, openUserDb } from './fixtures.ts';
import { storedFacts } from '../src/store/messages.ts';
import { describeFacts } from '../src/triage/facts.ts';
import { htmlFacts } from '../src/triage/html.ts';
import { ACCOUNT, b64, facts } from './helpers.ts';

const fake = fakeGoogle();

const CAMPAIGN = `<html><body>
  <a href="https://example.us1.list-manage.com/track/click?u=abc&amp;id=1">Shop the sale</a>
  <a href='https://example.us1.list-manage.com/track/click?u=abc&amp;id=2'>New arrivals</a>
  <a href="https://www.example.org/preferences">Preferences</a>
  <a href="mailto:hello@example.com">Write to us</a>
  <img src="https://cdn.example.com/banner.png" width="600" height="200">
  <img src="https://example.us1.list-manage.com/track/open.php?u=abc" height="1" width="1" alt="">
</body></html>`;

describe('htmlFacts', () => {
  it('finds the pixel and the click tracking in a campaign', () => {
    expect(htmlFacts(CAMPAIGN, 'example.com')).toEqual({ trackingPixel: true, linkHosts: 2, trackedLinks: true, linksOffDomain: true });
  });

  it('finds nothing in a message a person wrote', () => {
    const html = '<p>See <a href="https://www.example.com/docs/getting-started">the docs</a>.</p><img src="cid:signature" width="1" height="1">';
    expect(htmlFacts(html, 'example.com')).toEqual({ trackingPixel: false, linkHosts: 1, trackedLinks: false, linksOffDomain: false });
    expect(htmlFacts('<p>No links at all.</p>', 'example.com')).toEqual({ trackingPixel: false, linkHosts: 0, trackedLinks: false, linksOffDomain: false });
  });

  it('counts an image as a pixel when it is remote and 1×1 or hidden, however that is written', () => {
    const pixel = (img: string) => htmlFacts(img, 'example.com').trackingPixel;
    expect(pixel('<img style="width:1px; height:1px" src="https://t.example.com/o.gif">')).toBe(true);
    expect(pixel('<IMG SRC="//t.example.com/o.gif" STYLE="display:none !important">')).toBe(true);
    expect(pixel('<img src=https://t.example.com/o.gif width=0 height=0>')).toBe(true);
    expect(pixel('<img src="https://t.example.com/logo.png" width="1" height="40">')).toBe(false);
    expect(pixel('<img src="https://t.example.com/logo.png" style="max-width:1px; height:1px">')).toBe(false);
    expect(pixel('<img src="data:image/gif;base64,R0lGOD" width="1" height="1">')).toBe(false);
  });

  it("sees a tracking host on the sender's own domain, but not the sender's own site", () => {
    const html = '<a href="https://click.example.com/ls/1">One</a><a href="https://click.example.com/ls/2">Two</a>';
    expect(htmlFacts(html, 'example.com')).toMatchObject({ trackedLinks: true, linksOffDomain: false });
    expect(htmlFacts(html, 'click.example.com').trackedLinks).toBe(false);
  });

  it('sees links that all go through one host with encoded paths', () => {
    const redirect = (n: number) => `<a href="https://r.example.org/c/eJxVjEEOwiAQRa9C2Lc${n}Zk4AbXoKMMBQUh">Link ${n}</a>`;
    expect(htmlFacts([1, 2, 3].map(redirect).join(''), 'example.com')).toMatchObject({ linkHosts: 1, trackedLinks: true, linksOffDomain: true });
    const article = (n: number) => `<a href="https://blog.example.com/2026/how-we-rebuilt-our-search-index-part-${n}">Post ${n}</a>`;
    expect(htmlFacts([1, 2, 3].map(article).join(''), 'example.com').trackedLinks).toBe(false);
    // A notification's own links carry long references and go nowhere else.
    const own = (n: number) => `<a href="https://example.com/acme/app/pull/${n}?notification_referrer_id=NT_kwDOAbCdEf9876543210xyz${n}">Pull ${n}</a>`;
    expect(htmlFacts([1, 2, 3].map(own).join(''), 'example.com').trackedLinks).toBe(false);
  });

  it("compares sites, not hosts, when asking whether links go to the sender's domain", () => {
    const link = '<a href="https://shop.example.co.uk/sale">Sale</a>';
    expect(htmlFacts(link, 'mail.example.co.uk').linksOffDomain).toBe(false);
    expect(htmlFacts(link, 'other.co.uk').linksOffDomain).toBe(true);
  });
});

describe('readContent', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'Example <news@example.com>' }],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Shop the sale') } },
          { mimeType: 'text/html', body: { data: b64(CAMPAIGN) } },
        ],
      },
      { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }] },
    ],
  };

  it('reads the text, the HTML part and the facts from one message', () => {
    const content = readContent(payload);
    expect(content).toEqual({
      text: 'Shop the sale',
      html: CAMPAIGN,
      facts: { hasAttachments: false, words: 3, trackingPixel: true, linkHosts: 2, trackedLinks: true, linksOffDomain: true },
    });
  });

  it('counts a file as an attachment, not an image shown inline', () => {
    const withFile = { ...payload, parts: [...payload.parts, { mimeType: 'application/pdf', filename: 'invoice.pdf' }] };
    expect(readContent(withFile).facts.hasAttachments).toBe(true);
  });

  it('leaves the HTML facts out for mail with no HTML part', () => {
    expect(readContent({ mimeType: 'text/plain', body: { data: b64('hi') } })).toEqual({ text: 'hi', html: null, facts: { hasAttachments: false, words: 1 } });
  });

  it('counts the words of the whole text, past where the model’s copy is cut', () => {
    const content = readContent({ mimeType: 'text/plain', body: { data: b64('word '.repeat(2_000)) } });
    expect(content.text.endsWith('[truncated]')).toBe(true);
    expect(content.facts.words).toBe(2_000);
  });
});

describe('content facts', () => {
  it('are recorded with the message once it has been read; the model is shown an attachment and no tracking', async () => {
    const db = await openUserDb(ACCOUNT);
    const f = facts();
    await recordSync(db, ACCOUNT, [f], '2');
    expect(await storedFacts(db, ACCOUNT, f.messageId)).not.toHaveProperty('trackingPixel');

    const { api, mailbox, gmail } = connectGmail(fake.google);
    gmail.deliver({
      id: f.messageId,
      from: 'Shop <news@example.com>',
      text: 'Shop the sale',
      html: CAMPAIGN,
      attachments: [{ filename: 'lookbook.pdf', mimeType: 'application/pdf', data: '%PDF' }],
    });
    const evidence = await gatherEvidence({ db, api, mailbox }, f);
    expect(await storedFacts(db, ACCOUNT, f.messageId)).toMatchObject({ trackingPixel: true, trackedLinks: true, hasAttachments: true });
    const told = describeFacts(evidence.known);
    expect(told).toContain('Has attachments');
    expect(told.filter((line) => /track|link/i.test(line))).toEqual([]);
  });
});
