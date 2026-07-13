#!/usr/bin/env node
// smoke-test.mjs — read-only end-to-end check of jira-mcp.mjs over real stdio.
//
// Spawns the server, speaks JSON-RPC, and exercises READ-ONLY tools only:
//   initialize -> tools/list -> jira_myself -> jira_search -> jira_issue
//   -> jira_my_queue -> jira_transition(list) -> jira_health(all accounts)
//   -> confluence_search -> jira_link(list types) -> jira_sprints(board list)
// NO writes: no create/update/transition-exec/bulk/link-create/worklog-add/
// page-create-or-update/sprint-move. Verifies:
//   - tools/list advertises the v1.3.0 tools + enriched schemas
//   - jira_search returns pagination fields (nextPageToken/isLast/returned) and
//     NO phantom `total`
//   - jira_issue renders `description` as readable markdown, not raw ADF JSON
//   - jira_health checks every account (catches expired tokens)
//   - confluence_search / jira_link / jira_sprints new read paths work live
//
// Uses the real tokens in ~/Git/gsd-loop/config/atlassian.env against a live
// account (default: ypj; Confluence check uses CONF_ACCOUNT/CONF_SPACE, default
// iluvquran/QC). Degrades gracefully with a clear message if the config/network
// is unavailable or a site lacks Confluence/boards.
//
// Usage: node server/smoke-test.mjs [account]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, 'jira-mcp.mjs');
const ACCOUNT = process.argv[2] || 'ypj';
const CONF_ACCOUNT = process.env.CONF_ACCOUNT || 'iluvquran';
const CONF_SPACE = process.env.CONF_SPACE || 'QC';
const ENV_FILE = process.env.ATLASSIAN_ENV || join(homedir(), 'Git', 'gsd-loop', 'config', 'atlassian.env');
const MAP_FILE = process.env.JIRA_MAP || join(homedir(), 'Git', 'gsd-loop', 'config', 'jira-map.env');

if (!existsSync(ENV_FILE)) {
  console.log(`SKIP: accounts env not found at ${ENV_FILE} — cannot run live read-only smoke test.`);
  process.exit(0);
}

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ATLASSIAN_ENV: ENV_FILE, JIRA_MAP: MAP_FILE },
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

let idSeq = 1;
function rpc(method, params) {
  const id = idSeq++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 45000);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// tools/call returns result.content[0].text as a JSON string — parse it.
async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  return { isError: res.result?.isError, parsed, text };
}

const results = [];
const ok = (label, pass, detail) => { results.push({ label, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };

function looksLikeRawADF(v) {
  return v && typeof v === 'object' && (v.type === 'doc' || Array.isArray(v.content));
}

(async () => {
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    ok('initialize', !!init.result?.serverInfo, `server ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);

    ok('serverInfo is v1.5.0', init.result?.serverInfo?.version === '1.5.0', `v${init.result?.serverInfo?.version}`);

    const list = await rpc('tools/list', {});
    const tools = list.result?.tools || [];
    const names = tools.map((t) => t.name);
    ok('tools/list has jira_bulk_create', names.includes('jira_bulk_create'), `${tools.length} tools`);
    const v13 = ['jira_health', 'confluence_search', 'confluence_page', 'confluence_create_page', 'confluence_update_page', 'jira_link', 'jira_worklog', 'jira_sprints'];
    ok('tools/list has all v1.3.0 tools', v13.every((n) => names.includes(n)), `missing: ${v13.filter((n) => !names.includes(n)).join(',') || 'none'}`);
    ok('tools/list has jira_attachments (v1.5.0)', names.includes('jira_attachments'), `${tools.length} tools`);
    const createSchema = tools.find((t) => t.name === 'jira_create_issue')?.inputSchema?.properties || {};
    ok('jira_create_issue enriched schema', ['labels', 'priority', 'assignee', 'parent', 'duedate'].every((k) => k in createSchema),
      `props: ${Object.keys(createSchema).join(',')}`);
    const searchSchema = tools.find((t) => t.name === 'jira_search')?.inputSchema?.properties || {};
    ok('jira_search has fields+cursor+count', ['fields', 'cursor', 'count'].every((k) => k in searchSchema));
    ok('tools/list has jira_my_queue (v1.2.0)', names.includes('jira_my_queue'));
    const transSchema = tools.find((t) => t.name === 'jira_transition')?.inputSchema?.properties || {};
    ok('jira_transition has forbid_category guard', 'forbid_category' in transSchema);
    const updSchema = tools.find((t) => t.name === 'jira_update_issue')?.inputSchema?.properties || {};
    ok('jira_update_issue accepts update verb', 'update' in updSchema);

    // ---- live read-only calls ----
    const me = await callTool('jira_myself', { account: ACCOUNT });
    if (me.isError) { ok('jira_myself (live)', false, me.text.slice(0, 200)); throw new Error('live-auth-failed'); }
    ok('jira_myself (live)', !!me.parsed.accountId, `${me.parsed.displayName} <${me.parsed.email}> on ${me.parsed.site}`);

    const search = await callTool('jira_search', { account: ACCOUNT, jql: 'created >= "2000-01-01" ORDER BY created DESC', max: 3, count: true });
    if (search.isError) { ok('jira_search (live)', false, search.text.slice(0, 200)); throw new Error('search-failed'); }
    const s = search.parsed;
    ok('jira_search no phantom total', !('total' in s), `keys: ${Object.keys(s).join(',')}`);
    ok('jira_search pagination fields', 'nextPageToken' in s && 'isLast' in s && 'returned' in s,
      `returned=${s.returned} isLast=${s.isLast} nextPageToken=${s.nextPageToken ? 'present' : 'null'} approxCount=${s.approxCount}`);

    const firstKey = s.issues?.[0]?.key;
    if (!firstKey) {
      ok('jira_issue (live)', false, 'no issues returned by search to inspect (account may be empty)');
    } else {
      const issue = await callTool('jira_issue', { account: ACCOUNT, key: firstKey });
      if (issue.isError) { ok('jira_issue (live)', false, issue.text.slice(0, 200)); }
      else {
        const desc = issue.parsed.description;
        const isMarkdown = desc == null || typeof desc === 'string';
        ok('jira_issue description is markdown/text (not raw ADF)', isMarkdown && !looksLikeRawADF(desc),
          desc == null ? `${firstKey}: (no description)` : `${firstKey}: "${String(desc).replace(/\n/g, ' ').slice(0, 80)}"`);
        // sanity: raw:true still returns ADF
        const rawIssue = await callTool('jira_issue', { account: ACCOUNT, key: firstKey, raw: true });
        const rawDesc = rawIssue.parsed.description;
        ok('jira_issue raw:true returns ADF', rawDesc == null || looksLikeRawADF(rawDesc),
          rawDesc == null ? '(no description to compare)' : 'raw ADF preserved');
      }
    }

    // ---- jira_my_queue (read-only sweep of To-Do queue) ----
    const queue = await callTool('jira_my_queue', { account: ACCOUNT });
    if (queue.isError) { ok('jira_my_queue (live)', false, queue.text.slice(0, 200)); }
    else {
      const q = queue.parsed;
      const hasShape = Array.isArray(q.queues) && Array.isArray(q.errors) && typeof q.jql === 'string';
      const acctQueue = (q.queues || []).find((x) => x.account === ACCOUNT);
      ok('jira_my_queue returns queues[]+errors[]+jql', hasShape,
        `queues=${q.queues?.length} ${acctQueue ? `${ACCOUNT}: ${acctQueue.count} To-Do, accountId ${acctQueue.accountId ? 'present' : 'MISSING'}` : ''}`);
      ok('jira_my_queue JQL uses statusCategory + null-safe labels',
        /statusCategory = "To Do"/.test(q.jql) && /labels IS EMPTY OR labels NOT IN/.test(q.jql), q.jql);
    }

    // ---- jira_transition list surfaces to_category (read-only) ----
    if (firstKey) {
      const trans = await callTool('jira_transition', { account: ACCOUNT, key: firstKey });
      if (trans.isError) { ok('jira_transition to_category (live)', false, trans.text.slice(0, 200)); }
      else {
        const ts = trans.parsed.transitions || [];
        const withCat = ts.filter((t) => 'to_category' in t);
        ok('jira_transition exposes to_category', ts.length === 0 || withCat.length === ts.length,
          `${firstKey}: ${ts.length} transitions, categories: ${[...new Set(ts.map((t) => t.to_category))].join(',') || '(none available)'}`);
      }
    }
    // ---- jira_health across ALL accounts (read-only /myself sweep) ----
    const health = await callTool('jira_health', {});
    if (health.isError) { ok('jira_health (live)', false, health.text.slice(0, 200)); }
    else {
      const h = health.parsed;
      const shape = Array.isArray(h.accounts) && typeof h.ok_count === 'number' && typeof h.failed_count === 'number';
      ok('jira_health checks every account', shape && h.checked >= 1,
        `${h.ok_count}/${h.checked} ok, ${h.failed_count} failed` + (h.failed_count ? ` [${h.accounts.filter((a) => !a.ok).map((a) => a.account).join(',')}]` : ''));
      ok('jira_health entries have ok/displayName/tokenHint', h.accounts.every((a) => 'ok' in a && (a.ok ? a.displayName : a.error)),
        h.accounts.map((a) => `${a.account}:${a.ok ? 'ok' : 'FAIL'}`).join(' '));
    }

    // ---- confluence_search on a real space (read-only CQL) ----
    const conf = await callTool('confluence_search', { account: CONF_ACCOUNT, space: CONF_SPACE, text: '', limit: 5 });
    if (conf.isError) {
      ok('confluence_search (live)', false, `${CONF_ACCOUNT}/${CONF_SPACE}: ${conf.text.slice(0, 160)}`);
    } else {
      const c = conf.parsed;
      ok('confluence_search returns results[] + cql', Array.isArray(c.results) && typeof c.cql === 'string',
        `${CONF_ACCOUNT}/${CONF_SPACE}: size=${c.size} cql='${c.cql}' first='${(c.results[0]?.title || '').slice(0, 40)}'`);
      // Bonus read-only: fetch the first page's ADF body -> markdown.
      const pid = c.results?.find((r) => r.type === 'page' && r.id)?.id;
      if (pid) {
        const pg = await callTool('confluence_page', { account: CONF_ACCOUNT, id: String(pid) });
        ok('confluence_page renders body markdown', !pg.isError && (pg.parsed.body == null || typeof pg.parsed.body === 'string'),
          pg.isError ? pg.text.slice(0, 120) : `page ${pid} "${(pg.parsed.title || '').slice(0, 40)}" v${pg.parsed.version}`);
      }
    }

    // ---- jira_link LIST types (read-only) ----
    const links = await callTool('jira_link', { account: ACCOUNT });
    if (links.isError) { ok('jira_link list types (live)', false, links.text.slice(0, 200)); }
    else {
      const lt = links.parsed.link_types || [];
      ok('jira_link lists link types', Array.isArray(lt) && lt.length > 0 && lt.every((t) => t.name),
        `${lt.length} types: ${lt.map((t) => t.name).slice(0, 6).join(', ')}`);
    }

    // ---- jira_sprints board list (read-only) ----
    const proj = firstKey ? firstKey.split('-')[0] : null;
    if (proj) {
      const sp = await callTool('jira_sprints', { account: ACCOUNT, project: proj });
      if (sp.isError) { ok('jira_sprints board list (live)', false, sp.text.slice(0, 200)); }
      else {
        const s = sp.parsed;
        const shape = Array.isArray(s.boards);
        const nSprints = (s.boards || []).reduce((n, b) => n + (b.sprints?.length || 0), 0);
        ok('jira_sprints lists boards (graceful if none)', shape,
          `${proj}: ${s.boards.length} board(s), ${nSprints} active/future sprint(s)${s.note ? ` — ${s.note}` : ''}`);
      }
    }

    // ---- jira_attachments LIST (read-only) ----
    if (firstKey) {
      const atts = await callTool('jira_attachments', { account: ACCOUNT, key: firstKey });
      if (atts.isError) { ok('jira_attachments list (live)', false, atts.text.slice(0, 200)); }
      else {
        const a = atts.parsed;
        ok('jira_attachments list returns attachments[]', Array.isArray(a.attachments) && typeof a.count === 'number',
          `${firstKey}: ${a.count} attachment(s)`);
      }
    }

  } catch (e) {
    if (!['live-auth-failed', 'search-failed'].includes(e.message)) ok('unexpected error', false, e.message);
  } finally {
    child.stdin.end();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    child.kill();
    process.exit(failed.length ? 1 : 0);
  }
})();
