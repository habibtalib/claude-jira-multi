#!/usr/bin/env node
// jira-mcp.mjs — multi-site Jira/Confluence MCP server (stdio), zero dependencies.
//
// One server, every Atlassian site you have. Auth = per-account API tokens
// (Basic auth) from a local env file — no OAuth, nothing to re-authenticate.
// The account is resolved automatically from the folder the client runs in
// (via map.env), and every tool accepts an explicit `account` argument so any
// site can be queried from any folder.
//
// Config (see config.example/):
//   ~/.config/jira-multi/accounts.env   <NAME>_SITE / <NAME>_EMAIL / <NAME>_TOKEN
//   ~/.config/jira-multi/map.env        <folder>=<account>[:PROJECT[:SPACE]] , default=<account>
// Overrides: JIRA_MULTI_CONFIG (config dir), ATLASSIAN_ENV (accounts file),
//            JIRA_MAP (map file), JIRA_ACCOUNT (force default account).

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = process.env.JIRA_MULTI_CONFIG || join(homedir(), '.config', 'jira-multi');
const ENV_FILE = process.env.ATLASSIAN_ENV || join(CONFIG_DIR, 'accounts.env');
const MAP_FILE = process.env.JIRA_MAP || join(CONFIG_DIR, 'map.env');

// ---------- config ----------

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function loadAccounts() {
  const env = parseEnvFile(ENV_FILE);
  const accounts = {};
  for (const key of Object.keys(env)) {
    const m = key.match(/^([A-Z0-9_]+)_SITE$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    accounts[name] = {
      site: env[`${m[1]}_SITE`],
      email: env[`${m[1]}_EMAIL`] || '',
      token: env[`${m[1]}_TOKEN`] || '',
    };
  }
  return accounts;
}

// map.env lines: <folder-name>=<account>[:<PROJECT-KEY>[:<SPACE-KEY>]]
// plus optional: default=<account>
function loadMap() {
  const raw = parseEnvFile(MAP_FILE);
  const map = {};
  let fallback = null;
  for (const [repo, val] of Object.entries(raw)) {
    const [account, project, space] = val.split(':');
    if (repo === 'default') { fallback = account; continue; }
    map[repo.toLowerCase()] = { account, project: project || null, space: space || null };
  }
  return { map, fallback };
}

// Resolution order: explicit arg > JIRA_ACCOUNT env > map.env entry (cwd walked
// upward) > folder name contains an account name > map.env default= > the only
// configured account.
function resolveAccount(explicit, accounts, cwd = process.cwd()) {
  const { map, fallback } = loadMap();
  if (explicit) return { name: explicit.toLowerCase(), via: 'explicit', mapEntry: map[basename(cwd).toLowerCase()] || null };
  if (process.env.JIRA_ACCOUNT) return { name: process.env.JIRA_ACCOUNT.toLowerCase(), via: 'JIRA_ACCOUNT env', mapEntry: null };
  let dir = cwd;
  while (dir && dir !== dirname(dir)) {
    const b = basename(dir).toLowerCase();
    if (map[b]) return { name: map[b].account, via: `map.env (${b})`, mapEntry: map[b] };
    dir = dirname(dir);
  }
  const b = basename(cwd).toLowerCase();
  for (const name of Object.keys(accounts)) {
    if (b.includes(name)) return { name, via: `folder name contains '${name}'` };
  }
  if (fallback) return { name: fallback, via: 'map.env default=' };
  const names = Object.keys(accounts);
  if (names.length === 1) return { name: names[0], via: 'only configured account' };
  return { name: names[0] || 'unconfigured', via: 'first configured account (set default= in map.env)' };
}

function getAccount(explicit) {
  const accounts = loadAccounts();
  const r = resolveAccount(explicit, accounts);
  const acct = accounts[r.name];
  if (!acct) throw new Error(`account '${r.name}' not configured in ${ENV_FILE} (need ${r.name.toUpperCase()}_SITE/_EMAIL/_TOKEN). Configured: ${Object.keys(accounts).join(', ') || 'none — see config.example/accounts.env.example'}`);
  if (!acct.token) throw new Error(`account '${r.name}' has no API token — add ${r.name.toUpperCase()}_TOKEN to ${ENV_FILE} (create at https://id.atlassian.com/manage-profile/security/api-tokens while logged in as ${acct.email})`);
  return { name: r.name, via: r.via, mapEntry: r.mapEntry || null, ...acct };
}

// ---------- Atlassian REST ----------

async function rest(acct, method, path, body) {
  const url = `https://${acct.site}.atlassian.net${path}`;
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${acct.email}:${acct.token}`).toString('base64'),
    Accept: 'application/json',
  };
  const opts = { method, headers };
  if (body !== undefined && body !== null && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const msg = data?.errorMessages?.join('; ') || data?.message || text.slice(0, 500) || res.statusText;
    // Atlassian quirk: 401 is returned both for bad credentials AND for valid
    // credentials that simply lack access to this site.
    const hint = res.status === 401 ? ' (401 can also mean this account has no access to this site — try another `account`)' : '';
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${msg}${hint}`);
  }
  return data;
}

const slimIssue = (i) => ({
  key: i.key,
  summary: i.fields?.summary,
  status: i.fields?.status?.name,
  type: i.fields?.issuetype?.name,
  priority: i.fields?.priority?.name,
  assignee: i.fields?.assignee?.displayName || null,
  updated: i.fields?.updated,
});

// ---------- tools ----------

const TOOLS = [
  {
    name: 'jira_accounts',
    description: 'List configured Atlassian accounts/sites, token status, and which account the current folder resolves to. Use this first if unsure which site applies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jira_search',
    description: 'Search issues with JQL on the folder-resolved (or explicitly named) Jira site. Returns slim issue list.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: "JQL, e.g. 'project = ABC AND status != Done ORDER BY updated DESC'" },
        account: { type: 'string', description: 'Account name from accounts.env. Omit to auto-resolve from folder.' },
        max: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_issue',
    description: 'Get one issue (summary, description, status, recent comments) by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. ABC-123' },
        account: { type: 'string', description: 'Account name; omit to auto-resolve from folder.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_create_issue',
    description: 'Create an issue. Project defaults to the folder-mapped project key from map.env if omitted. If the project lacks the requested issue type, falls back to an available type and labels the issue instead.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        project: { type: 'string', description: 'Project key; omit to use folder-mapped project.' },
        type: { type: 'string', description: 'Issue type name (default Task)' },
        description: { type: 'string', description: 'Plain-text description' },
        account: { type: 'string' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'jira_update_issue',
    description: 'Update issue fields (raw Jira fields object, e.g. {"summary":"new"} or ADF description).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        fields: { type: 'object', description: 'Jira fields object for PUT /issue' },
        account: { type: 'string' },
      },
      required: ['key', 'fields'],
    },
  },
  {
    name: 'jira_transition',
    description: 'List available transitions for an issue, or execute one by name/id when `to` is given.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        to: { type: 'string', description: 'Transition name or id to execute; omit to just list.' },
        account: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_comment',
    description: 'Add a plain-text comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        body: { type: 'string' },
        account: { type: 'string' },
      },
      required: ['key', 'body'],
    },
  },
  {
    name: 'jira_myself',
    description: 'Verify credentials: GET /myself on the resolved (or named) account.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } } },
  },
  {
    name: 'jira_api',
    description: "Raw Atlassian REST escape hatch — any Jira ('/rest/api/3/...') or Confluence ('/wiki/rest/api/...', '/wiki/api/v2/...') path on any account.",
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET|POST|PUT|DELETE' },
        path: { type: 'string', description: "Path starting with /rest/... or /wiki/..." },
        body: { type: 'object', description: 'JSON body for POST/PUT' },
        account: { type: 'string' },
      },
      required: ['method', 'path'],
    },
  },
];

const adf = (text) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function callTool(name, args = {}) {
  if (name === 'jira_accounts') {
    const accounts = loadAccounts();
    const r = resolveAccount(null, accounts);
    return {
      cwd: process.cwd(),
      resolved_default: { account: r.name, via: r.via },
      accounts: Object.fromEntries(Object.entries(accounts).map(([n, a]) => [n, {
        site: `${a.site}.atlassian.net`, email: a.email, token: a.token ? 'set' : 'MISSING',
      }])),
      map_file: MAP_FILE,
      accounts_file: ENV_FILE,
    };
  }

  const acct = getAccount(args.account);
  const meta = { account: acct.name, site: `${acct.site}.atlassian.net`, resolved_via: acct.via };

  switch (name) {
    case 'jira_myself': {
      const me = await rest(acct, 'GET', '/rest/api/3/myself');
      return { ...meta, accountId: me.accountId, displayName: me.displayName, email: me.emailAddress };
    }
    case 'jira_search': {
      const max = args.max || 20;
      const data = await rest(acct, 'POST', '/rest/api/3/search/jql', {
        jql: args.jql, maxResults: max,
        fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated'],
      });
      return { ...meta, total: data.total ?? data.issues?.length, issues: (data.issues || []).map(slimIssue) };
    }
    case 'jira_issue': {
      const i = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(args.key)}?fields=summary,description,status,issuetype,priority,assignee,reporter,updated,created,labels,comment`);
      return {
        ...meta, ...slimIssue(i),
        reporter: i.fields?.reporter?.displayName || null,
        created: i.fields?.created,
        labels: i.fields?.labels,
        description: i.fields?.description,
        comments: (i.fields?.comment?.comments || []).slice(-10).map((c) => ({
          author: c.author?.displayName, created: c.created, body: c.body,
        })),
      };
    }
    case 'jira_create_issue': {
      const project = args.project || acct.mapEntry?.project;
      if (!project) throw new Error("no project key: pass `project` or add '<folder>=<account>:<PROJECT>' to map.env");
      const fields = {
        project: { key: project },
        summary: args.summary,
        issuetype: { name: args.type || 'Task' },
      };
      if (args.description) fields.description = adf(args.description);
      let out, typeNote;
      try {
        out = await rest(acct, 'POST', '/rest/api/3/issue', { fields });
      } catch (e) {
        if (!/valid issue type/i.test(e.message)) throw e;
        // project (e.g. team-managed kanban) lacks this type — pick closest available
        const metaTypes = await rest(acct, 'GET', `/rest/api/3/issue/createmeta/${project}/issuetypes`);
        const names = (metaTypes.issueTypes || metaTypes.values || []).map((t) => t.name);
        const want = (args.type || 'Task').toLowerCase();
        const pick = names.find((n) => n.toLowerCase() === want) || names.find((n) => n === 'Task') || names[0];
        if (!pick) throw e;
        fields.issuetype = { name: pick };
        if (args.type && pick.toLowerCase() !== want) {
          fields.labels = [...(fields.labels || []), args.type.toLowerCase()];
          typeNote = `type '${args.type}' unavailable in ${project} (has: ${names.join(', ')}); created as ${pick} with label '${args.type.toLowerCase()}'`;
        }
        out = await rest(acct, 'POST', '/rest/api/3/issue', { fields });
      }
      return { ...meta, key: out.key, url: `https://${acct.site}.atlassian.net/browse/${out.key}`, ...(typeNote ? { note: typeNote } : {}) };
    }
    case 'jira_update_issue': {
      await rest(acct, 'PUT', `/rest/api/3/issue/${encodeURIComponent(args.key)}`, { fields: args.fields });
      return { ...meta, key: args.key, updated: true };
    }
    case 'jira_transition': {
      const list = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`);
      const transitions = (list.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
      if (!args.to) return { ...meta, key: args.key, transitions };
      const t = transitions.find((x) => x.id === String(args.to) || x.name.toLowerCase() === String(args.to).toLowerCase());
      if (!t) throw new Error(`no transition '${args.to}' on ${args.key}; available: ${transitions.map((x) => x.name).join(', ')}`);
      await rest(acct, 'POST', `/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`, { transition: { id: t.id } });
      return { ...meta, key: args.key, transitioned_to: t.to || t.name };
    }
    case 'jira_comment': {
      const out = await rest(acct, 'POST', `/rest/api/3/issue/${encodeURIComponent(args.key)}/comment`, { body: adf(args.body) });
      return { ...meta, key: args.key, comment_id: out.id };
    }
    case 'jira_api': {
      if (!/^\/(rest|wiki|gateway)\//.test(args.path)) throw new Error("path must start with /rest/..., /wiki/... or /gateway/...");
      const out = await rest(acct, args.method.toUpperCase(), args.path, args.body);
      return { ...meta, result: out };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- MCP stdio (newline-delimited JSON-RPC 2.0) ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let pending = 0;
let stdinClosed = false;
const maybeExit = () => { if (stdinClosed && pending === 0) process.exit(0); };

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jira-multi', version: '1.0.0' },
      });
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // no response to notifications
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      pending++;
      try {
        const result = await callTool(params.name, params.arguments || {});
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      } finally {
        pending--;
        maybeExit();
      }
    } else if (id !== undefined) {
      replyErr(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyErr(id, -32603, e.message);
  }
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
