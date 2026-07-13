#!/usr/bin/env node
// smoke-test-md.mjs — OFFLINE unit tests for the markdown->ADF writer (mdToAdf)
// and the round-trip through the ADF->markdown reader (adfToMarkdown). Pure/offline:
// no network, no tokens, no Jira/Confluence writes. Run: node server/smoke-test-md.mjs

import { mdToAdf, adfToMarkdown } from './jira-mcp.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
// Find the first node of a given type anywhere in an ADF tree.
const find = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const c of node.content || []) { const r = find(c, type); if (r) return r; }
  return null;
};
const findAll = (node, type, acc = []) => {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === type) acc.push(node);
  for (const c of node.content || []) findAll(c, type, acc);
  return acc;
};
const hasMark = (node, mark) => (node.marks || []).some((m) => m.type === mark);
const findTextWithMark = (node, mark) => findAll(node, 'text').find((t) => hasMark(t, mark));

// ---------- 1. plain text -> single unchanged paragraph ----------
{
  const doc = mdToAdf('just plain text');
  ok('plain: doc/version', doc.type === 'doc' && doc.version === 1);
  ok('plain: single paragraph', doc.content.length === 1 && doc.content[0].type === 'paragraph');
  ok('plain: single text node unchanged',
    JSON.stringify(doc.content[0].content) === JSON.stringify([{ type: 'text', text: 'just plain text' }]),
    JSON.stringify(doc.content[0].content));
}

// ---------- 2. representative rich markdown ----------
const md = [
  '# Title',
  '',
  'A para with **bold**, *italic*, `code`, and a [link](https://example.com).',
  '',
  '- one',
  '- two',
  '  - nested a',
  '  - nested b',
  '- three',
  '',
  '1. first',
  '2. second',
  '',
  '> a quoted line',
  '',
  '```js',
  'const x = 1;',
  'console.log(x);',
  '```',
  '',
  '---',
].join('\n');

const doc = mdToAdf(md);
ok('rich: valid doc root', doc.type === 'doc' && doc.version === 1 && Array.isArray(doc.content));

// heading
const h = find(doc, 'heading');
ok('rich: heading level 1', h && h.attrs?.level === 1 && adfToMarkdown(h).startsWith('# Title'), h && `level=${h.attrs?.level}`);

// paragraph inline marks
const strong = findTextWithMark(doc, 'strong');
const em = findTextWithMark(doc, 'em');
const code = findTextWithMark(doc, 'code');
const link = findTextWithMark(doc, 'link');
ok('rich: strong mark', !!strong && strong.text === 'bold');
ok('rich: em mark', !!em && em.text === 'italic');
ok('rich: code mark', !!code && code.text === 'code');
ok('rich: link mark + href', !!link && link.text === 'link' && (link.marks.find((m) => m.type === 'link')?.attrs?.href === 'https://example.com'),
  link && JSON.stringify(link.marks));

// bullet list with nesting: bulletList -> listItem -> (paragraph, nested bulletList)
const bl = find(doc, 'bulletList');
ok('rich: bulletList present', !!bl && bl.content.every((li) => li.type === 'listItem'));
const nested = bl && bl.content.map((li) => find(li, 'bulletList')).find(Boolean);
ok('rich: bulletList has nested bulletList', !!nested, nested && `nested items=${nested.content.length}`);
const firstItemPara = bl && find(bl.content[0], 'paragraph');
ok('rich: listItem contains paragraph', !!firstItemPara);

// ordered list
const ol = find(doc, 'orderedList');
ok('rich: orderedList present', !!ol && ol.content.length === 2);

// blockquote
const bq = find(doc, 'blockquote');
ok('rich: blockquote present', !!bq && !!find(bq, 'paragraph'));

// code block with language
const cb = find(doc, 'codeBlock');
ok('rich: codeBlock + language attr', !!cb && cb.attrs?.language === 'js', cb && `lang=${cb.attrs?.language}`);
ok('rich: codeBlock text preserved',
  !!cb && (cb.content?.[0]?.text || '').includes('const x = 1;') && (cb.content?.[0]?.text || '').includes('console.log(x);'));

// horizontal rule
ok('rich: rule present', !!find(doc, 'rule'));

// ---------- 3. round-trip sanity (mdToAdf -> adfToMarkdown recovers structure) ----------
const back = adfToMarkdown(doc);
ok('round-trip: heading survives', /^#\s+Title/m.test(back), back.split('\n')[0]);
ok('round-trip: bold survives', /\*\*bold\*\*/.test(back));
ok('round-trip: italic survives', /(^|[^*])\*italic\*/.test(back));
ok('round-trip: inline code survives', /`code`/.test(back));
ok('round-trip: link survives', /\[link\]\(https:\/\/example\.com\)/.test(back));
ok('round-trip: bullet list survives', /(^|\n)- one/.test(back) && /nested a/.test(back));
ok('round-trip: ordered list survives', /(^|\n)1\. first/.test(back));
ok('round-trip: code fence + lang survives', /```js[\s\S]*const x = 1;[\s\S]*```/.test(back));
ok('round-trip: rule survives', /(^|\n)---(\n|$)/.test(back));

// ---------- 4. empty input -> a paragraph (valid doc, no empty text node) ----------
{
  const e = mdToAdf('');
  ok('empty: valid doc with a block', e.type === 'doc' && e.content.length >= 1);
  ok('empty: no invalid empty text node', !findAll(e, 'text').some((t) => t.text === ''));
}

console.log(`\n${pass}/${pass + fail} md->ADF checks passed.`);
process.exit(fail ? 1 : 0);
