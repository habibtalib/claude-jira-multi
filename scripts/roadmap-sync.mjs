#!/usr/bin/env node
// roadmap-sync <repo-dir> [--dry] — publish a repo's planning state to Jira
// (one Task per roadmap phase, idempotent) and Confluence (one living status
// page per repo+milestone). Reads the GSD convention: .planning/ROADMAP.md
// with `## Phase N: Name` headings and .planning/STATE.md frontmatter.
// Mapping in map.env, creds in accounts.env. --dry parses and prints without
// touching the API.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONF = process.env.JIRA_MULTI_CONFIG || path.join(os.homedir(), '.config', 'jira-multi');
const ACCOUNTS_FILE = process.env.ATLASSIAN_ENV || path.join(CONF, 'accounts.env');
const MAP_FILE = process.env.JIRA_MAP || path.join(CONF, 'map.env');

const repoDir = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!repoDir) { console.error('usage: roadmap-sync <repo-dir> [--dry]'); process.exit(1); }
const repo = path.basename(path.resolve(repoDir));

const envf = (f) => Object.fromEntries(
  fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]) : []);

const creds = envf(ACCOUNTS_FILE);
const map = envf(MAP_FILE);
const entry = map[repo];
if (!entry) { console.error(`${repo}: no mapping in ${MAP_FILE} (add: ${repo}=account:PROJECTKEY[:SPACEKEY], or run jira-init.sh)`); process.exit(2); }
const [account, projectKey, spaceKey] = entry.split(':');
if (!projectKey) { console.error(`${repo}: mapping has no project key (need ${repo}=${account}:PROJECTKEY)`); process.exit(2); }
const A = account.toUpperCase();
const site = creds[`${A}_SITE`], email = creds[`${A}_EMAIL`], token = creds[`${A}_TOKEN`];

// ── parse .planning ───────────────────────────────────────────────────────────
const planning = path.join(repoDir, '.planning');
const read = f => { try { return fs.readFileSync(path.join(planning, f), 'utf8'); } catch { return ''; } };
const state = read('STATE.md');
const fm = k => (state.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, 'm')) || [])[1] || '';
const milestone = fm('milestone') || 'current';
const status = fm('status') || 'unknown';

const roadmap = read('ROADMAP.md');
const phases = [];
for (const m of roadmap.matchAll(/^#{2,4}\s*(?:✅\s*)?Phase\s+([\d.]+)[:\s—–-]+(.+?)\s*$/gim)) {
  const done = /✅|COMPLETE/i.test(m[2]) || /✅/.test(m[0]);
  phases.push({ num: m[1], name: m[2].replace(/[✅✓]|\(COMPLETE\)/gi, '').trim(), done });
}
if (!phases.length) { console.error(`${repo}: no phases found in .planning/ROADMAP.md`); process.exit(2); }

console.log(`${repo} → ${account} (${site || '?'}.atlassian.net) project=${projectKey} space=${spaceKey || '-'} | milestone=${milestone} status=${status} phases=${phases.length}`);

if (DRY) {
  for (const p of phases) console.log(`  [dry] upsert Jira ${projectKey}: "[GSD] ${repo} phase ${p.num} — ${p.name}"${p.done ? ' (done)' : ''}`);
  if (spaceKey) console.log(`  [dry] upsert Confluence page "GSD — ${repo} — ${milestone}" in space ${spaceKey}`);
  process.exit(0);
}
if (!site || !email || !token) { console.error(`account '${account}' missing ${A}_SITE/_EMAIL/_TOKEN in ${ACCOUNTS_FILE}`); process.exit(2); }

const api = async (method, p, body) => {
  const r = await fetch(`https://${site}.atlassian.net${p}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
               Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};
const adf = t => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

// ── Jira: one Task per phase, idempotent by summary ──────────────────────────
// Local cache (.planning/.jira-sync-cache.json) guards against Jira's search
// index lag: a JQL search right after creation can miss the issue and duplicate it.
const cacheFile = path.join(planning, '.jira-sync-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
const saveCache = () => fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

for (const p of phases) {
  const summary = `[GSD] ${repo} phase ${p.num} — ${p.name}`;
  if (cache[summary]) {
    try {
      await api('GET', `/rest/api/3/issue/${cache[summary]}?fields=summary`);
      console.log(`  = ${cache[summary]} exists (${summary}) [cache]`);
      continue;
    } catch { delete cache[summary]; saveCache(); }
  }
  const jql = `project = ${projectKey} AND summary ~ "\\"[GSD] ${repo} phase ${p.num}\\""`;
  const found = await api('POST', '/rest/api/3/search/jql', { jql, fields: ['summary', 'status'], maxResults: 1 });
  if (found.issues?.length) {
    cache[summary] = found.issues[0].key; saveCache();
    console.log(`  = ${found.issues[0].key} exists (${summary})`);
  } else {
    const desc = `Auto-created by roadmap-sync from ${repo}/.planning (milestone ${milestone}). Phase ${p.num}: ${p.name}.`;
    const made = await api('POST', '/rest/api/3/issue', {
      fields: { project: { key: projectKey }, issuetype: { name: 'Task' }, summary, description: adf(desc), labels: ['gsd', repo] },
    });
    cache[summary] = made.key; saveCache();
    console.log(`  + ${made.key} created (${summary})`);
  }
}

// ── Confluence: living status page per repo+milestone ────────────────────────
if (spaceKey) {
  const title = `GSD — ${repo} — ${milestone}`;
  const rows = phases.map(p => `<tr><td>${p.num}</td><td>${p.name}</td><td>${p.done ? '✅ done' : 'pending'}</td></tr>`).join('');
  const html = `<p><strong>Status:</strong> ${status} · synced ${new Date().toISOString().slice(0, 10)} by roadmap-sync</p>
<table><tbody><tr><th>Phase</th><th>Name</th><th>State</th></tr>${rows}</tbody></table>
<p>Source of truth: <code>${repo}/.planning/</code></p>`;
  const q = await api('GET', `/wiki/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=version`);
  if (q.results?.length) {
    const pg = q.results[0];
    await api('PUT', `/wiki/rest/api/content/${pg.id}`, {
      id: pg.id, type: 'page', title, version: { number: pg.version.number + 1 },
      body: { storage: { value: html, representation: 'storage' } },
    });
    console.log(`  ~ Confluence page updated: ${title}`);
  } else {
    await api('POST', '/wiki/rest/api/content', {
      type: 'page', title, space: { key: spaceKey },
      body: { storage: { value: html, representation: 'storage' } },
    });
    console.log(`  + Confluence page created: ${title} (space ${spaceKey})`);
  }
}
