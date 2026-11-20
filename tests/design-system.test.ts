import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

// docs/design.md as checks. Screens kept drifting from the system one view at a time (grey fills, a stray
// shadow, red and yellow written by hand, type set by eye), so what a screen may write is decided here.

const WEB = new URL('../web/src/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const ALL = sources(WEB);
const SYSTEM = new Set(ALL.filter((path) => relative(WEB, path).startsWith('system/')));
// The specimen page shows the tokens themselves, so it may name them.
const SCREENS = ALL.filter((path) => !SYSTEM.has(path) && relative(WEB, path) !== 'views/system.tsx');

interface Word {
  file: string;
  line: number;
  word: string;
}

/** Every word of every string literal: class names live in strings, and the page's own text mostly does not. */
function words(path: string): Word[] {
  const source = readFileSync(path, 'utf8');
  const found: Word[] = [];
  for (const match of source.matchAll(/"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`/g)) {
    const line = source.slice(0, match.index).split('\n').length;
    for (const word of (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/)) {
      if (word) found.push({ file: relative(WEB, path), line, word });
    }
  }
  return found;
}

/** A class name without its variants (`md:`, `hover:`, `aria-[current=page]:`) or `!` and `-`. */
function utility(word: string): string {
  return (word.split(/:(?![^[]*\])/).pop() ?? word).replace(/^[!-]+/, '');
}

function check(paths: string[], rules: [RegExp, string][]): string[] {
  const failures: string[] = [];
  for (const path of paths) {
    for (const { file, line, word } of words(path)) {
      if (word.startsWith('--')) continue; // a command's flag in the page's text, never a class
      const name = utility(word);
      for (const [pattern, use] of rules) {
        if (pattern.test(name)) failures.push(`web/src/${file}:${line} \`${word}\`: ${use}`);
      }
    }
  }
  return failures;
}

const CHROME = 'fills, frames, corners and shadows belong to parts in web/src/system. Use or extend a part (and show it at /system).';

describe('screens style nothing themselves', () => {
  test('no fills, frames, corners, shadows, red, yellow or raw colours outside web/src/system', () => {
    const failures = check(SCREENS, [
      [/^(bg|border|ring|shadow|rounded|outline|divide)(-|$)/, CHROME],
      [/^(fill|stroke|from|via|to)-/, CHROME],
      [/^text-destructive/, 'red is a failure: use `Failure` (or `Note tone="failure"`).'],
      [/^(text-highlight|hl$)/, 'yellow comes only from a part: `Button variant="mark"`, a `look` tone, `Highlight`.'],
      [/^\[[\w-]+:.+\]$/, CHROME],
      [/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$|^(rgb|rgba|hsl|oklch|oklab)\(/i, 'colours are tokens in web/src/index.css, used by parts.'],
    ]);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('no inline style outside web/src/system', () => {
    const failures = SCREENS.filter((path) => /\bstyle=\{/.test(readFileSync(path, 'utf8'))).map(
      (path) => `web/src/${relative(WEB, path)}: an inline style is only for a part's value computed from data, in web/src/system.`,
    );
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('one type scale', () => {
  const css = readFileSync(join(WEB, 'index.css'), 'utf8');
  const scale = [...css.matchAll(/^\s*--text-([a-z]+):/gm)].map((match) => `text-${match[1]}`);

  test('a size is a step of the scale in web/src/index.css, never one set by eye', () => {
    const offScale = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `text-${n}xl`)].filter(
      (name) => !scale.includes(name),
    );
    const use = `use ${scale.join(', ')}, or a role class (.statement, .title, .heading, .name, .figure, .slug).`;
    const failures = check(ALL, [
      [/^text-\[[\d.]+(px|rem)\]$/, use],
      [new RegExp(`^(${offScale.join('|')})$`), `not on the scale, so it sets nothing: ${use}`],
    ]);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('cn knows each step of the scale as a size, so a colour beside it does not remove it', () => {
    const named = readFileSync(join(WEB, 'lib/utils.ts'), 'utf8');
    const own = scale.filter((name) => !['text-sm', 'text-base'].includes(name)).filter((name) => !named.includes(`'${name.slice('text-'.length)}'`));
    expect(own, 'add each to the font-size group in web/src/lib/utils.ts').toEqual([]);
  });

  test('nothing is set under 12px but a column head', () => {
    const small = [...css.matchAll(/(--text-[a-z]+|font-size):\s*([\d.]+)px/g)].filter((match) => Number(match[2]) < 12).map((match) => match[1]);
    expect(small, 'docs/design.md: nothing under 12px but a column head.').toEqual(['--text-head']);
    const heads = ALL.filter((path) => /\btext-head\b/.test(readFileSync(path, 'utf8'))).map((path) => relative(WEB, path));
    expect(heads, 'text-head is for Th alone, in capitals.').toEqual(['system/table.tsx']);
  });
});

describe('as little chrome as it takes', () => {
  // What floats over the page is filled so it can cover what is under it. Nothing else is.
  const FLOATING = new Set([
    'dialog.tsx',
    'layer.tsx',
    'panel.tsx',
    'menu.tsx',
    'answer-picker.tsx',
    'select.tsx',
    'toast.tsx',
    'hover-card.tsx',
    'tooltip.tsx',
    'nav.tsx',
    'chart.tsx',
    'confirm.tsx',
    'table.tsx',
  ]);

  test('only a part that floats has a surface', () => {
    const grounded = [...SYSTEM].filter((path) => !FLOATING.has(relative(join(WEB, 'system'), path)));
    const failures = check(grounded, [
      [/^bg-(card|popover|background)\b/, 'only what floats (a panel, a dialog, a menu, a toast) is filled; a sheet, a table or a list sits on the page.'],
    ]);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('one shadow: the edge of the sheet beneath', () => {
    const css = readFileSync(join(WEB, 'index.css'), 'utf8');
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)]
      .map((match) => match[1])
      .filter((value) => !/^\S+px \S+px 0 0 var\(--edge\)$/.test(value ?? ''));
    expect(shadows, 'docs/design.md: --edge, hard and offset, on a sheet and what floats. Buttons have none.').toEqual([]);
    const failures = check(ALL, [[/^shadow(-|$)/, 'the one shadow is the .sheet edge in web/src/index.css.']]);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('yellow means look here', () => {
  test('a highlighted or ink button is never down a list, and a screen has one highlighted button at most', () => {
    const failures: string[] = [];
    for (const path of SCREENS) {
      const source = readFileSync(path, 'utf8');
      const file = `web/src/${relative(WEB, path)}`;
      for (const row of source.matchAll(/<(Tr|RowActions)\b[\s\S]*?<\/\1>/g)) {
        for (const press of row[0].matchAll(/variant="(mark|ink)"/g)) {
          const line = source.slice(0, (row.index ?? 0) + (press.index ?? 0)).split('\n').length;
          failures.push(`${file}:${line} variant="${press[1]}" in a row: a press repeated down a list is quiet.`);
        }
      }
      const marks = [...source.matchAll(/variant="mark"/g)].length;
      if (marks > 1) failures.push(`${file}: ${marks} buttons with variant="mark"; a screen has one thing waiting on the reader at most.`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('red means a failure the reader can do something about', () => {
  test('a screen says a failure only as the error of a press or a load, never in words of its own or as a status', () => {
    // Sift retries what it does in the background (a mailbox change, a Gmail filter, a model call) and reports
    // what never lands; the page is for a press that just failed, or a page that could not load.
    const failures: string[] = [];
    for (const path of SCREENS) {
      const source = readFileSync(path, 'utf8');
      const file = `web/src/${relative(WEB, path)}`;
      for (const said of source.matchAll(/<Failure\b[^>]*>([\s\S]*?)<\/Failure>/g)) {
        const line = source.slice(0, said.index).split('\n').length;
        if (!/^\{[\s\S]*\b(error|failed)\b[\s\S]*\}$/.test(said[1]!.trim()))
          failures.push(`${file}:${line} <Failure> holds words of its own: it holds the error of a press or a load.`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('red is also deleting, always through DeleteButton', () => {
  test('a press that removes or deletes is a DeleteButton, and nothing else draws its red', () => {
    // One question for every deletion: a Button or ConfirmButton saying Remove or Delete is one built by hand.
    const failures: string[] = [];
    for (const path of [...SCREENS, join(WEB, 'views/system.tsx')]) {
      const source = readFileSync(path, 'utf8');
      const file = `web/src/${relative(WEB, path)}`;
      const at = (index: number | undefined) => source.slice(0, index).split('\n').length;
      for (const press of source.matchAll(/<(Button|ConfirmButton)\b[^<]*?>\s*(Remove|Delete)\b/g))
        failures.push(`${file}:${at(press.index)} a ${press[1]} that says ${press[2]}: deleting is a DeleteButton.`);
      for (const press of source.matchAll(/variant="(danger|destroy)"/g))
        failures.push(`${file}:${at(press.index)} variant="${press[1]}": only DeleteButton draws it.`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

test('whatever can be pressed shows the pointer', () => {
  // A choice in a menu or a select is pressed like a button. Only a disabled one keeps the arrow, through a variant.
  const bare = [...SYSTEM].flatMap((path) => words(path)).filter(({ word }) => word === 'cursor-default');
  const failures = bare.map(({ file, line }) => `web/src/${file}:${line} cursor-default: an interactive element takes cursor-pointer (docs/design.md).`);
  expect(failures, failures.join('\n')).toEqual([]);
});

test('a sender in a list is a SenderCell, name over address, the same on every page', () => {
  // The reader names the sender over each message, not in a row.
  const own = new Set(['components/sender.tsx', 'views/reader.tsx']);
  const failures = SCREENS.filter((path) => !own.has(relative(WEB, path)) && /<SenderLink\b/.test(readFileSync(path, 'utf8'))).map(
    (path) => `web/src/${relative(WEB, path)}: a row names its sender with SenderCell (web/src/components/sender.tsx).`,
  );
  expect(failures).toEqual([]);
});

test('a tooltip is a Tooltip, never a title, so none shows on a touch screen', () => {
  // A frame's title names it for a screen reader, and shows nothing.
  const failures = ALL.flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/<(?!iframe\b)[a-z][a-z0-9]*\b[^<>]*?\stitle=/g)].map(
      (match) => `web/src/${relative(WEB, path)}:${readFileSync(path, 'utf8').slice(0, match.index).split('\n').length}: use a Tooltip`,
    ),
  );
  expect(failures, failures.join('\n')).toEqual([]);
});

test("a table's column heads are Heads of Th, so every list shows or hides them the same way", () => {
  const failures = SCREENS.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const file = `web/src/${relative(WEB, path)}`;
    return [
      ...(/<(thead|th)\b/.test(source) ? [`${file}: write column heads as Heads and Th`] : []),
      ...((source.match(/<Table\b/g) ?? []).length > (source.match(/<Heads\b/g) ?? []).length ? [`${file}: a Table without Heads`] : []),
    ];
  });
  expect(failures, failures.join('\n')).toEqual([]);
});

test('how long ago is drawn only by Ago, so the server and the browser never draw it differently', () => {
  // The server draws a screen at one moment and the browser takes it over at another, in the reader's zone.
  const drawn = ALL.map((path) => relative(WEB, path)).filter(
    (file) => file !== 'system/ago.tsx' && file !== 'lib/format.ts' && /\bago\(/.test(readFileSync(join(WEB, file), 'utf8')),
  );
  expect(drawn, 'use <Ago at={…} /> from @/system').toEqual([]);
});

test('every part is on the specimen page', () => {
  const index = readFileSync(join(WEB, 'system/index.ts'), 'utf8');
  const parts = [...index.matchAll(/export \{([^}]*)\}/g)]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((name) => name.trim())
    .filter((name) => /^[A-Z]/.test(name));
  // Toaster is mounted once by the app; the specimen page shows toasts through useToast.
  const specimen = readFileSync(join(WEB, 'views/system.tsx'), 'utf8');
  const missing = parts.filter((name) => name !== 'Toaster' && !new RegExp(`<${name}\\b`).test(specimen));
  expect(missing, 'add each to web/src/views/system.tsx, in its states (docs/design.md)').toEqual([]);
});

test('keys are for working through a list, and screens bind none of their own', () => {
  // Keys kept spreading to every list and step because the parts allowed them. Only these lists are worked through one item after another.
  const LISTS = new Set(['views/suggestions.tsx', 'components/mail-log.tsx', 'views/inbox.tsx']);
  const failures = SCREENS.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const file = relative(WEB, path);
    return [
      ...(/<Table keys\b/.test(source) && !LISTS.has(file)
        ? [`web/src/${file}: <Table keys> is only for For review, Inbox and Activity (docs/design.md, Keys).`]
        : []),
      ...(/\bshortcut=|\buseShortcut\(/.test(source) ? [`web/src/${file}: a screen binds no key; keys belong to the parts (docs/design.md, Keys).`] : []),
    ];
  });
  expect(failures, failures.join('\n')).toEqual([]);
});
