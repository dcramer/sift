import { beforeEach, describe, expect, it } from 'vitest';
import { cleanHtml, mailDocument } from '../src/dashboard/mail-html.ts';
import { readContent } from '../src/gmail/body.ts';
import { recordSync } from '../src/store/accounts.ts';
import { readBodies } from '../src/store/query.ts';
import { people } from '../src/store/people.ts';
import type { Sql } from '../src/store/sql.ts';
import type { Store } from '../src/store/store.ts';
import { onePerson, startDashboard } from './fixtures.ts';
import { ACCOUNT, b64, facts } from './helpers.ts';

const MARKER = 'only-in-the-html-7f3a';
const HTML = `<!DOCTYPE html><html><head><title>Sale</title><meta http-equiv="refresh" content="0;url=https://tracker.example.com/"><base href="https://tracker.example.com/"></head>
<body style="margin:0"><table bgcolor="#ffffff"><tr><td style="color:#333;background:url(https://cdn.example.com/bg.png)">
<p>${MARKER}</p><img src="https://cdn.example.com/hero.png" width="600" alt="Hero"><img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo">
<a href="https://shop.example.com/sale">Shop</a></td></tr></table><script>fetch('https://tracker.example.com/')</script></body></html>`;

describe('cleaning a message for the frame', () => {
  it('removes scripts, frames, forms, base and meta, keeping what is inside a form', () => {
    const cleaned = cleanHtml(
      '<script>alert(1)</script><SCRIPT src="https://x.example.com/a.js"></SCRIPT><iframe src="https://x.example.com/"></iframe><object data="https://x.example.com/"></object><embed src="https://x.example.com/">' +
        '<form action="https://x.example.com/"><input name="q" formaction="https://x.example.com/"></form><base href="https://x.example.com/"><meta http-equiv="refresh" content="0;url=https://x.example.com/"><link rel="stylesheet" href="https://x.example.com/a.css">',
    );
    expect(cleaned).toBe('<input name="q">');
  });

  it('removes event handlers and javascript: addresses, however they are spelled', () => {
    expect(cleanHtml('<img src=x onerror="alert(1)" ONLOAD=alert(2) alt="a">')).toBe('<img alt="a">');
    for (const href of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'jav&#x61;script:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '/relative',
      '#top',
    ])
      expect(cleanHtml(`<a href="${href}">x</a>`), href).toBe('<a>x</a>');
    expect(cleanHtml('<div style="x" onclick=alert(1)>y</div>')).toBe('<div style="x">y</div>');
  });

  it('opens every link in a new tab that is told nothing of where it came from', () => {
    expect(cleanHtml('<a href="https://example.com/a" target="_self" rel="opener">a</a>')).toBe(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">a</a>',
    );
    expect(cleanHtml("<a href='mailto:me@example.com'>m</a>")).toBe('<a href="mailto:me@example.com" target="_blank" rel="noopener noreferrer">m</a>');
  });

  it('drops remote images and keeps inline ones; CSS is left to the frame policy', () => {
    expect(cleanHtml('<img src="https://cdn.example.com/a.png" srcset="https://cdn.example.com/b.png 2x" alt="A">')).toBe('<img alt="A">');
    expect(cleanHtml('<td background="https://cdn.example.com/bg.png">x</td>')).toBe('<td>x</td>');
    expect(cleanHtml('<img src="cid:logo">')).toBe('<img>');
    expect(cleanHtml('<img src="data:image/png;base64,AAAA">')).toBe('<img src="data:image/png;base64,AAAA">');
    expect(cleanHtml('<style>p{color:red}</style>')).toBe('<style>p{color:red}</style>');
  });

  it('writes out only the tags it read, so a malformed one cannot slip past', () => {
    expect(cleanHtml('<scr<script>alert(1)</script>ipt>alert(2)</script>')).toBe('alert(1)ipt>alert(2)');
    expect(cleanHtml('<img src="x" alt="never closed')).toBe('&lt;img src="x" alt="never closed');
    expect(cleanHtml('<svg><style><img src=x onerror=alert(1)></style></svg>after')).toBe('after');
    expect(cleanHtml('<p title="a>b" class=c>x</p>')).toBe('<p title="a>b" class="c">x</p>');
    expect(cleanHtml('<!-- <script>alert(1)</script> -->kept')).toBe('kept');
    // A tag that never ends is read once, not retried from every position: read again from each, this many
    // characters would take minutes, so the budget leaves a loaded machine plenty of room.
    const long = `<a ${'b'.repeat(200_000)}`;
    const started = performance.now();
    expect(cleanHtml(long)).toBe(long.replace('<', '&lt;'));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('puts the message on white paper, after its doctype', () => {
    const document = mailDocument(HTML);
    expect(document).toMatch(/^<!DOCTYPE html><style>:root\{color-scheme:light;background:#fff;color:#000;[^<]*<\/style><html>/);
    expect(document).not.toMatch(/script|refresh|<base|<title|hero\.png|https:\/\/tracker/);
    expect(document).toContain('background:url(https://cdn.example.com/bg.png)');
  });

  it("reads a message's text and its HTML part, each as it is", () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain') } },
        { mimeType: 'text/html', body: { data: b64('<p>café</p>') } },
      ],
    };
    expect(readContent(payload)).toMatchObject({ text: 'plain', html: '<p>café</p>' });
    expect(readContent({ mimeType: 'text/plain', body: { data: b64('plain') } }).html).toBeNull();
  });
});

describe('the frame route', () => {
  let store: Store;
  let db: Sql;

  beforeEach(async () => {
    ({ store, db } = await onePerson(ACCOUNT));
    await recordSync(
      db,
      ACCOUNT,
      ['m1', 'plain', 'unheld'].map((messageId) => facts({ messageId })),
      '2',
      1000,
    );
    await db.insert(readBodies).values([
      { accountId: ACCOUNT, messageId: 'm1', bodyText: 'Sale', bodyHtml: HTML, fetchedAt: 1000 },
      { accountId: ACCOUNT, messageId: 'plain', bodyText: 'Plain', bodyHtml: null, fetchedAt: 1000 },
    ]);
  });

  it('sends the HTML Sift holds, cleaned, under a strict policy of its own, in a sandbox, loading nothing', async () => {
    const { call } = await startDashboard(people(store));
    const reply = await call('GET', `/api/message/html?id=m1`);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain(MARKER);
    expect(reply.text).not.toContain('<script');
    expect(reply.headers).toMatchObject({
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    const policy = String(reply.headers['content-security-policy']);
    expect(policy).not.toMatch(/allow-scripts|allow-same-origin|script-src|connect-src|https?:/);
  });

  it('says so, in the frame, when Sift holds no HTML for it', async () => {
    const { call } = await startDashboard(people(store));
    for (const id of ['plain', 'unheld', 'unknown']) {
      const reply = await call('GET', `/api/message/html?id=${id}`);
      expect(reply.status, id).toBe(404);
      expect(reply.headers['content-security-policy']).toContain('sandbox');
    }
    expect((await call('GET', '/api/message/html?mailbox=other%40example.com&id=m1')).status).toBe(404);
  });

  it('tells the page whether Sift holds the HTML, so it never offers a frame with nothing in it', async () => {
    const { call } = await startDashboard(people(store));
    const open = async (id: string) => (await call('GET', `/api/message?id=${id}`)).body;
    expect(await open('m1')).toMatchObject({ body: 'Sale', hasHtml: true });
    expect(await open('plain')).toMatchObject({ body: 'Plain', hasHtml: false });
    expect(await open('unheld')).toMatchObject({ body: null, hasHtml: false });
  });
});
