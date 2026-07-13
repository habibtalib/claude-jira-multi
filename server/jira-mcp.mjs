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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry on 429 (rate limit) and transient 5xx (502/503/504). Honors the
// Retry-After header exactly when present (Atlassian penalizes early retries),
// otherwise exponential backoff with full jitter, capped ~30s, max 4 attempts.
const MAX_RETRIES = 4;
const RETRYABLE = new Set([429, 502, 503, 504]);

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

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter > 0
        ? retryAfter * 1000
        : Math.random() * Math.min(2 ** attempt * 500, 30000);
      if (process.env.JIRA_MCP_DEBUG) {
        const reason = res.headers.get('ratelimit-reason') || '';
        console.error(`[jira-mcp] ${res.status} on ${method} ${path} — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(wait)}ms ${reason}`);
      }
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 2000) }; }
    if (!res.ok) {
      const msg = data?.errorMessages?.join('; ') || data?.message || text.slice(0, 500) || res.statusText;
      // Atlassian quirk: 401 is returned both for bad credentials AND for valid
      // credentials that simply lack access to this site.
      const hint = res.status === 401 ? ' (401 can also mean this account has no access to this site — try another `account`)' : '';
      const reason = res.headers.get('ratelimit-reason');
      const rlHint = RETRYABLE.has(res.status) && reason ? ` (rate-limited after ${MAX_RETRIES} retries; reason: ${reason})` : '';
      throw new Error(`${method} ${url} → HTTP ${res.status}: ${msg}${hint}${rlHint}`);
    }
    return data;
  }
}

const BASE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated'];

const slimIssue = (i, fields) => {
  const out = {
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    type: i.fields?.issuetype?.name,
    priority: i.fields?.priority?.name,
    assignee: i.fields?.assignee?.displayName || null,
    updated: i.fields?.updated,
  };
  // Pass through any extra requested fields (labels, duedate, parent, story points, etc.)
  if (fields) for (const f of fields) {
    if (!BASE_FIELDS.includes(f) && i.fields && f in i.fields) out[f] = i.fields[f];
  }
  return out;
};

// ---------- ADF <-> markdown ----------

// Convert inline ADF nodes (text + marks) to markdown.
function adfInline(nodes = []) {
  return (nodes || []).map((n) => {
    if (n.type === 'text') {
      let t = n.text || '';
      for (const m of n.marks || []) {
        if (m.type === 'code') t = '`' + t + '`';
        else if (m.type === 'strong') t = '**' + t + '**';
        else if (m.type === 'em') t = '*' + t + '*';
        else if (m.type === 'strike') t = '~~' + t + '~~';
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href || ''})`;
      }
      return t;
    }
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return '@' + (n.attrs?.text || n.attrs?.displayName || n.attrs?.id || '');
    if (n.type === 'emoji') return n.attrs?.text || n.attrs?.shortName || '';
    if (n.type === 'inlineCard') return n.attrs?.url || n.attrs?.data?.url || '';
    if (n.content) return adfInline(n.content);
    return '';
  }).join('');
}

// Convert an ADF document (or fragment) to readable markdown. Handles the block
// types GSD/Jira actually emit; unknown nodes recurse into their content.
function adfToMarkdown(doc) {
  if (doc == null) return null;
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object') return String(doc);
  const block = (nodes, indent) => (nodes || []).map((n) => node(n, indent)).filter((s) => s !== '' && s != null).join('\n\n');
  const node = (n, indent = '') => {
    switch (n.type) {
      case 'doc': return block(n.content, indent);
      case 'paragraph': return indent + adfInline(n.content);
      case 'heading': return indent + '#'.repeat(n.attrs?.level || 1) + ' ' + adfInline(n.content);
      case 'rule': return indent + '---';
      case 'hardBreak': return '';
      case 'codeBlock': {
        const lang = n.attrs?.language || '';
        const code = (n.content || []).map((c) => c.text || '').join('');
        return indent + '```' + lang + '\n' + code.split('\n').map((l) => indent + l).join('\n') + '\n' + indent + '```';
      }
      case 'blockquote':
        return block(n.content, '').split('\n').map((l) => indent + '> ' + l).join('\n');
      case 'panel': {
        const tag = (n.attrs?.panelType || 'info').toUpperCase();
        return block(n.content, '').split('\n').map((l, i) => indent + '> ' + (i === 0 ? `[${tag}] ` : '') + l).join('\n');
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = n.type === 'orderedList';
        const out = [];
        (n.content || []).forEach((li, idx) => {
          const marker = ordered ? `${idx + 1}. ` : '- ';
          const pad = ' '.repeat(marker.length);
          block(li.content, '').split('\n').forEach((l, i) => out.push(indent + (i === 0 ? marker : pad) + l));
        });
        return out.join('\n');
      }
      case 'listItem': return block(n.content, indent);
      case 'mediaSingle':
      case 'mediaGroup': return indent + '[media]';
      case 'table': return indent + '[table — use raw:true to inspect]';
      default:
        if (n.content) return block(n.content, indent);
        if (n.text) return indent + n.text;
        return '';
    }
  };
  return node(doc, '');
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'jira_accounts',
    description: 'List configured Atlassian accounts/sites, token status, and which account the current folder resolves to. Use this first if unsure which site applies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jira_search',
    description: 'Search issues with JQL on the folder-resolved (or explicitly named) Jira site. Token-paginated (nextPageToken/isLast); auto-loops internally until `max` collected. NOTE: the enhanced-search endpoint no longer returns a total — pass count:true for an approximate count.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: "JQL, e.g. 'project = ABC AND status != Done ORDER BY updated DESC'" },
        account: { type: 'string', description: 'Account name from accounts.env. Omit to auto-resolve from folder.' },
        max: { type: 'number', description: 'Max issues to collect across pages (default 20).' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Field ids/names to return (default: summary,status,issuetype,priority,assignee,updated). Add labels,duedate,parent,customfield_XXXXX etc.' },
        cursor: { type: 'string', description: 'nextPageToken from a previous call, to fetch the following page.' },
        count: { type: 'boolean', description: 'When true, also return approxCount via POST /search/approximate-count.' },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_my_queue',
    description: "Aggregate the caller's To-Do queue (assignee = currentUser() AND statusCategory = \"To Do\") across one or all configured accounts in a single call. Per-account failures are returned in errors[] instead of aborting the sweep. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: "One account name, or 'all'/omitted = every configured account." },
        project: { type: 'string', description: 'Restrict to a single project key.' },
        max: { type: 'number', description: 'Max issues per account (default 10).' },
        types: { type: 'array', items: { type: 'string' }, description: 'Issue types to include (default ["Task","Bug"]).' },
        exclude_labels: { type: 'array', items: { type: 'string' }, description: 'Labels that disqualify an issue (default: the auto-* markers + blocked,needs-info,question,no-auto). Null-safe: issues with no labels are always included.' },
      },
    },
  },
  {
    name: 'jira_issue',
    description: 'Get one issue (summary, description, status, recent comments) by key. Description and comment bodies are rendered to readable markdown by default (pass raw:true for raw ADF JSON).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. ABC-123' },
        account: { type: 'string', description: 'Account name; omit to auto-resolve from folder.' },
        raw: { type: 'boolean', description: 'Return raw ADF JSON for description/comments instead of markdown.' },
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
        description: { type: 'string', description: 'Plain-text description (wrapped in ADF).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set.' },
        priority: { type: 'string', description: 'Priority name, e.g. High.' },
        assignee: { type: 'string', description: "'me' | email | display name | accountId (same resolution as jira_assign)." },
        parent: { type: 'string', description: 'Parent issue key (for subtasks or epic children).' },
        duedate: { type: 'string', description: 'Due date, YYYY-MM-DD.' },
        components: { type: 'array', items: { type: 'string' }, description: 'Component names.' },
        fields: { type: 'object', description: 'Extra raw Jira fields merged last (escape hatch for custom fields).' },
        account: { type: 'string' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'jira_bulk_create',
    description: 'Create many issues in one call (chunked at 50 per POST /issue/bulk). Each item accepts the same fields as jira_create_issue. Returns created issues[] and per-item errors[] — partial success is normal. Project defaults to the folder-mapped project.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          description: 'Array of issue specs: {summary, type?, description?, labels?, priority?, assignee?, parent?, duedate?, components?, project?, fields?}.',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              type: { type: 'string' },
              description: { type: 'string' },
              labels: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string' },
              assignee: { type: 'string' },
              parent: { type: 'string' },
              duedate: { type: 'string' },
              components: { type: 'array', items: { type: 'string' } },
              project: { type: 'string' },
              fields: { type: 'object' },
            },
            required: ['summary'],
          },
        },
        account: { type: 'string' },
      },
      required: ['issues'],
    },
  },
  {
    name: 'jira_update_issue',
    description: 'Update issue fields (raw Jira fields object, e.g. {"summary":"new"} or ADF description).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        fields: { type: 'object', description: 'Jira fields object for PUT /issue (SET semantics — replaces field values).' },
        update: { type: 'object', description: 'Jira `update` verb object for non-destructive edits, e.g. {"labels":[{"add":"auto-inprogress"}]} adds a label without clobbering existing ones. Combine with or use instead of `fields`.' },
        account: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_transition',
    description: 'List available transitions for an issue (each with its target statusCategory), or execute one by name/id when `to` is given. Pass forbid_category to make the server refuse a transition whose target lands in that category.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        to: { type: 'string', description: 'Transition name or id to execute; omit to just list.' },
        forbid_category: { type: 'string', description: "statusCategory key ('new'|'indeterminate'|'done') the server must REFUSE to transition into, e.g. 'done' to make Done unreachable. Applied only when executing." },
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
    name: 'jira_assign',
    description: "Assign an issue. `assignee` accepts 'me', 'reporter' (hand back to whoever filed it), an accountId, or an email/name to search for.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        assignee: { type: 'string', description: "'me' | 'reporter' | accountId | email or display name" },
        account: { type: 'string' },
      },
      required: ['key', 'assignee'],
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
  {
    name: 'jira_health',
    description: 'Verify credentials for ALL configured accounts (or a passed subset) in one call — GET /myself per account. Returns per-account {ok, displayName, email, error, tokenHint}. Catches expired/revoked API tokens early (they hard-expire ≤1yr). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        accounts: { type: 'array', items: { type: 'string' }, description: 'Account names to check; omit to check every configured account.' },
      },
    },
  },
  {
    name: 'confluence_search',
    description: 'Search Confluence with CQL (v1 /wiki/rest/api/search — CQL stays v1). Pass raw `cql`, or `text` (+ optional `space` key, auto-scoped from map.env) to build `text ~ "..."`. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        cql: { type: 'string', description: 'Raw CQL, e.g. \'type=page AND space=QC AND text ~ "roadmap"\'. Takes precedence over text/space.' },
        text: { type: 'string', description: 'Free-text query (builds `text ~ "..."`).' },
        space: { type: 'string', description: 'Confluence space KEY to scope to; omit to use the folder-mapped space from map.env.' },
        limit: { type: 'number', description: 'Max results (default 20).' },
        account: { type: 'string' },
      },
    },
  },
  {
    name: 'confluence_page',
    description: 'Get one Confluence page by id (v2 /wiki/api/v2/pages/{id}?body-format=atlas_doc_format). The ADF body is rendered to readable markdown by default (pass raw:true for the raw ADF JSON). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id (numeric string).' },
        raw: { type: 'boolean', description: 'Return the raw ADF body instead of markdown.' },
        account: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'confluence_create_page',
    description: 'Create a Confluence page (v2 /wiki/api/v2/pages). Resolves numeric spaceId from a space KEY. Body is markdown wrapped as ADF (atlas_doc_format; the ADF value is JSON-encoded per the v2 contract).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Page body (markdown/plain text, wrapped in ADF).' },
        space: { type: 'string', description: 'Space KEY; omit to use the folder-mapped space from map.env.' },
        spaceId: { type: 'string', description: 'Numeric spaceId (skips KEY resolution if you already have it).' },
        parentId: { type: 'string', description: 'Parent page id (optional).' },
        account: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'confluence_update_page',
    description: 'Update a Confluence page (v2 PUT /wiki/api/v2/pages/{id}). Fetches the current version and increments version.number. Title defaults to the existing title if omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id.' },
        body: { type: 'string', description: 'New page body (markdown/plain text, wrapped in ADF).' },
        title: { type: 'string', description: 'New title; omit to keep the current one.' },
        account: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'jira_link',
    description: 'Create an issue link, or list available link types when called with no inward/outward/type. type matched case-insensitively against link-type names AND inward/outward phrasings (Blocks / Relates / Duplicate / "is blocked by" …).',
    inputSchema: {
      type: 'object',
      properties: {
        inward: { type: 'string', description: 'Inward issue key (the one that "is blocked by" / "relates to" the outward issue).' },
        outward: { type: 'string', description: 'Outward issue key (the one that "blocks" / "duplicates" the inward issue).' },
        type: { type: 'string', description: 'Link type, e.g. Blocks, Relates, Duplicate. Omit (with no keys) to list all link types.' },
        account: { type: 'string' },
      },
    },
  },
  {
    name: 'jira_worklog',
    description: 'Add a worklog to an issue (timeSpent like "1h 30m", optional comment, optional started), or list recent worklogs when timeSpent is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key.' },
        timeSpent: { type: 'string', description: 'Time spent, Jira format e.g. "1h 30m", "45m", "2d". Omit to list recent worklogs.' },
        comment: { type: 'string', description: 'Worklog comment (wrapped in ADF).' },
        started: { type: 'string', description: 'Start time ISO-ish (e.g. 2026-07-13T10:00:00.000+0000); defaults to now.' },
        account: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_sprints',
    description: 'List boards + their active/future sprints for a project, or move issues into a sprint. {project} lists boards & sprints; {sprint, issues:[keys]} moves ≤50 issues to a sprint (sprint = numeric id, or a name resolved against the project\'s sprints). Projects with no board are handled gracefully.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key (to list boards/sprints, or to resolve a sprint by name). Omit to use folder-mapped project.' },
        sprint: { type: 'string', description: 'Sprint id (numeric) or name to move issues into.' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Issue keys to move into `sprint` (≤50 per call, chunked).' },
        account: { type: 'string' },
      },
    },
  },
];

const adf = (text) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

// Resolve an assignee spec ('me' | 'reporter'/'creator' | accountId | email/name)
// to { accountId, label }. Shared by jira_assign and create-issue field building.
async function resolveAssignee(acct, spec, issueKey) {
  const who = String(spec).trim();
  if (who.toLowerCase() === 'me') {
    const me = await rest(acct, 'GET', '/rest/api/3/myself');
    return { accountId: me.accountId, label: me.displayName };
  }
  if (who.toLowerCase() === 'reporter' || who.toLowerCase() === 'creator') {
    if (!issueKey) throw new Error("assignee 'reporter'/'creator' needs an existing issue key");
    const i = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=reporter,creator`);
    const r = i.fields?.reporter || i.fields?.creator;
    if (!r?.accountId) throw new Error(`issue ${issueKey} has no reporter/creator to assign back to`);
    return { accountId: r.accountId, label: r.displayName };
  }
  if (!who.includes('@') && /^[0-9a-f][0-9a-f:_-]{9,}$/i.test(who)) return { accountId: who, label: who };
  const users = await rest(acct, 'GET', `/rest/api/3/user/search?query=${encodeURIComponent(who)}`);
  const u = users.find((x) => x.emailAddress === who) || users[0];
  if (!u) throw new Error(`no user found for '${who}' on ${acct.site}.atlassian.net`);
  return { accountId: u.accountId, label: u.displayName };
}

// Build a Jira `fields` object from a create spec (single or one bulk item).
async function buildCreateFields(acct, spec, defaultProject) {
  const project = spec.project || defaultProject;
  if (!project) throw new Error("no project key: pass `project` or add '<folder>=<account>:<PROJECT>' to map.env");
  const fields = {
    project: { key: project },
    summary: spec.summary,
    issuetype: { name: spec.type || 'Task' },
  };
  if (spec.description != null) fields.description = typeof spec.description === 'object' ? spec.description : adf(spec.description);
  if (spec.labels) fields.labels = spec.labels;
  if (spec.priority) fields.priority = { name: spec.priority };
  if (spec.parent) fields.parent = { key: spec.parent };
  if (spec.duedate) fields.duedate = spec.duedate;
  if (spec.components) fields.components = spec.components.map((c) => (typeof c === 'string' ? { name: c } : c));
  if (spec.assignee) fields.assignee = { accountId: (await resolveAssignee(acct, spec.assignee)).accountId };
  if (spec.fields) Object.assign(fields, spec.fields);
  return { fields, project };
}

// POST /issue with the team-managed issue-type fallback (project may lack the
// requested type; pick the closest available and label the issue instead).
async function createWithFallback(acct, project, fields, wantType) {
  try {
    const out = await rest(acct, 'POST', '/rest/api/3/issue', { fields });
    return { key: out.key };
  } catch (e) {
    if (!/valid issue type/i.test(e.message)) throw e;
    const metaTypes = await rest(acct, 'GET', `/rest/api/3/issue/createmeta/${project}/issuetypes`);
    const names = (metaTypes.issueTypes || metaTypes.values || []).map((t) => t.name);
    const want = (wantType || 'Task').toLowerCase();
    const pick = names.find((n) => n.toLowerCase() === want) || names.find((n) => n === 'Task') || names[0];
    if (!pick) throw e;
    fields.issuetype = { name: pick };
    let note;
    if (wantType && pick.toLowerCase() !== want) {
      fields.labels = [...(fields.labels || []), wantType.toLowerCase()];
      note = `type '${wantType}' unavailable in ${project} (has: ${names.join(', ')}); created as ${pick} with label '${wantType.toLowerCase()}'`;
    }
    const out = await rest(acct, 'POST', '/rest/api/3/issue', { fields });
    return { key: out.key, note };
  }
}

// Token-paginated JQL search collecting up to `max` raw issues. The enhanced
// /search/jql endpoint returns no total and maxResults is only an upper bound,
// so page via nextPageToken until isLast or `max` collected. Shared by
// jira_search and jira_my_queue.
async function searchJql(acct, jql, max, fields, cursor) {
  const collected = [];
  let token = cursor || undefined;
  let isLast = false;
  const PAGE_CAP = 25; // hard safety on internal loop iterations
  for (let page = 0; collected.length < max && page < PAGE_CAP; page++) {
    const req = { jql, maxResults: Math.min(max - collected.length, 100), fields };
    if (token) req.nextPageToken = token;
    const data = await rest(acct, 'POST', '/rest/api/3/search/jql', req);
    collected.push(...(data.issues || []));
    token = data.nextPageToken;
    isLast = data.isLast ?? !token;
    if (isLast || !token) break;
  }
  return { issues: collected, nextPageToken: token || null, isLast };
}

// Defaults for the "my To-Do queue" sweep. The label list keeps the autonomous
// loop's own markers (and human skip markers) out of the pickup set; the
// (labels IS EMPTY OR labels NOT IN (...)) form is mandatory — a bare NOT IN
// would silently drop every unlabeled issue.
const QUEUE_TYPES = ['Task', 'Bug'];
const QUEUE_EXCLUDE_LABELS = [
  'auto-inprogress', 'auto-needs-info', 'auto-attempted', 'auto-worked',
  'blocked', 'needs-info', 'question', 'no-auto',
];
const QUEUE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated', 'created', 'labels', 'reporter'];

function buildQueueJql({ project, types, excludeLabels } = {}) {
  const parts = ['assignee = currentUser()', 'statusCategory = "To Do"'];
  if (project) parts.push(`project = "${String(project).replace(/"/g, '')}"`);
  const t = (types && types.length ? types : QUEUE_TYPES).map((x) => `"${String(x).replace(/"/g, '')}"`).join(', ');
  parts.push(`issuetype IN (${t})`);
  const ex = (excludeLabels && excludeLabels.length ? excludeLabels : QUEUE_EXCLUDE_LABELS)
    .map((x) => `"${String(x).replace(/"/g, '')}"`).join(', ');
  parts.push(`(labels IS EMPTY OR labels NOT IN (${ex}))`);
  return parts.join(' AND ') + ' ORDER BY priority DESC, created ASC';
}

// Resolve a Confluence space KEY -> numeric spaceId (v2 needs the id, not the
// key). Cached per account+key for the process lifetime.
const _spaceIdCache = new Map();
async function resolveSpaceId(acct, spaceKey) {
  const ck = `${acct.name}:${spaceKey}`;
  if (_spaceIdCache.has(ck)) return _spaceIdCache.get(ck);
  const data = await rest(acct, 'GET', `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
  const id = data.results?.[0]?.id;
  if (!id) throw new Error(`no Confluence space with key '${spaceKey}' on ${acct.site}.atlassian.net`);
  _spaceIdCache.set(ck, id);
  return id;
}

// Confluence v2 wants the ADF body as a JSON-encoded STRING, not an object.
const confBody = (markdown) => ({ representation: 'atlas_doc_format', value: JSON.stringify(adf(markdown ?? '')) });

// Jira worklog `started` must be ...T..±HHMM (it rejects the trailing 'Z').
function worklogStarted(started) {
  if (started) return started;
  return new Date().toISOString().replace('Z', '+0000');
}

// Flatten active/future sprints across all of a project's boards (for name->id
// resolution when moving issues into a sprint).
async function listSprints(acct, project) {
  const boardsData = await rest(acct, 'GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`);
  const sprints = [];
  const seen = new Set();
  for (const b of boardsData.values || []) {
    try {
      const sd = await rest(acct, 'GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active,future`);
      for (const s of sd.values || []) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        sprints.push({ id: s.id, name: s.name, state: s.state });
      }
    } catch { /* board type without sprints (kanban) — skip */ }
  }
  return sprints;
}

async function callTool(name, args = {}) {
  if (name === 'jira_health') {
    const accounts = loadAccounts();
    const names = (args.accounts && args.accounts.length)
      ? args.accounts.map((n) => String(n).toLowerCase())
      : Object.keys(accounts);
    const report = [];
    for (const nm of names) {
      const tokenHint = accounts[nm]?.token ? '…' + accounts[nm].token.slice(-4) : null;
      try {
        const a = getAccount(nm);
        const t0 = Date.now();
        const me = await rest(a, 'GET', '/rest/api/3/myself');
        report.push({
          account: nm, site: `${a.site}.atlassian.net`, ok: true,
          displayName: me.displayName, email: me.emailAddress,
          latencyMs: Date.now() - t0, tokenHint: '…' + a.token.slice(-4),
        });
      } catch (e) {
        const expired = /HTTP 401/.test(e.message);
        report.push({
          account: nm, ok: false, error: e.message, tokenHint,
          hint: expired
            ? `token likely expired/revoked — recreate at https://id.atlassian.com/manage-profile/security/api-tokens and update ${ENV_FILE}`
            : 'check account config / network',
        });
      }
    }
    const failed = report.filter((r) => !r.ok);
    return { checked: report.length, ok_count: report.length - failed.length, failed_count: failed.length, accounts: report };
  }

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

  if (name === 'jira_my_queue') {
    const accounts = loadAccounts();
    const names = (args.account && String(args.account).toLowerCase() !== 'all')
      ? [String(args.account).toLowerCase()]
      : Object.keys(accounts);
    const max = args.max || 10;
    const jql = buildQueueJql({ project: args.project, types: args.types, excludeLabels: args.exclude_labels });
    const queues = [];
    const errors = [];
    for (const nm of names) {
      try {
        const a = getAccount(nm);
        const me = await rest(a, 'GET', '/rest/api/3/myself');
        const { issues } = await searchJql(a, jql, max, QUEUE_FIELDS);
        queues.push({
          account: nm, site: `${a.site}.atlassian.net`, accountId: me.accountId,
          count: issues.length, issues: issues.map((i) => slimIssue(i, QUEUE_FIELDS)),
        });
      } catch (e) {
        errors.push({ account: nm, error: e.message });
      }
    }
    return { jql, queues, errors };
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
      const fields = args.fields && args.fields.length ? args.fields : BASE_FIELDS;
      const { issues, nextPageToken, isLast } = await searchJql(acct, args.jql, max, fields, args.cursor || args.nextPageToken);
      const out = {
        ...meta,
        returned: issues.length,
        nextPageToken,
        isLast,
        issues: issues.map((i) => slimIssue(i, fields)),
      };
      if (args.count) {
        const c = await rest(acct, 'POST', '/rest/api/3/search/approximate-count', { jql: args.jql });
        out.approxCount = c.count;
      }
      return out;
    }
    case 'jira_issue': {
      const i = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(args.key)}?fields=summary,description,status,issuetype,priority,assignee,reporter,updated,created,labels,comment`);
      return {
        ...meta, ...slimIssue(i),
        reporter: i.fields?.reporter?.displayName || null,
        reporter_id: i.fields?.reporter?.accountId || null,
        assignee_id: i.fields?.assignee?.accountId || null,
        created: i.fields?.created,
        labels: i.fields?.labels,
        description: args.raw ? i.fields?.description : adfToMarkdown(i.fields?.description),
        comments: (i.fields?.comment?.comments || []).slice(-10).map((c) => ({
          author: c.author?.displayName, created: c.created,
          body: args.raw ? c.body : adfToMarkdown(c.body),
        })),
      };
    }
    case 'jira_create_issue': {
      const { fields, project } = await buildCreateFields(acct, args, acct.mapEntry?.project);
      const { key, note } = await createWithFallback(acct, project, fields, args.type);
      return { ...meta, key, url: `https://${acct.site}.atlassian.net/browse/${key}`, ...(note ? { note } : {}) };
    }
    case 'jira_bulk_create': {
      const specs = args.issues || [];
      if (!specs.length) throw new Error('jira_bulk_create needs a non-empty `issues` array');
      // Build each item's fields; collect build-time failures without aborting.
      const built = [];
      const errors = [];
      for (let idx = 0; idx < specs.length; idx++) {
        try {
          const { fields } = await buildCreateFields(acct, specs[idx], acct.mapEntry?.project);
          built.push({ idx, fields });
        } catch (e) {
          errors.push({ index: idx, summary: specs[idx]?.summary, error: e.message });
        }
      }
      const created = [];
      for (let i = 0; i < built.length; i += 50) {
        const chunk = built.slice(i, i + 50);
        const resp = await rest(acct, 'POST', '/rest/api/3/issue/bulk', {
          issueUpdates: chunk.map((b) => ({ fields: b.fields })),
        });
        for (const c of resp.issues || []) {
          created.push({ key: c.key, url: `https://${acct.site}.atlassian.net/browse/${c.key}` });
        }
        for (const err of resp.errors || []) {
          const localIdx = chunk[err.failedElementNumber]?.idx;
          const ee = err.elementErrors || {};
          errors.push({
            index: localIdx ?? err.failedElementNumber,
            summary: localIdx != null ? specs[localIdx]?.summary : undefined,
            error: (ee.errorMessages || []).join('; ') || JSON.stringify(ee.errors || {}) || 'unknown bulk error',
          });
        }
      }
      return { ...meta, created_count: created.length, error_count: errors.length, issues: created, errors };
    }
    case 'jira_update_issue': {
      if (args.fields == null && args.update == null) throw new Error('jira_update_issue needs `fields` and/or `update`');
      const body = {};
      if (args.fields != null) body.fields = args.fields;   // SET semantics
      if (args.update != null) body.update = args.update;   // ADD/REMOVE/SET verbs (non-destructive)
      await rest(acct, 'PUT', `/rest/api/3/issue/${encodeURIComponent(args.key)}`, body);
      return { ...meta, key: args.key, updated: true, applied: Object.keys(body) };
    }
    case 'jira_transition': {
      const list = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`);
      const transitions = (list.transitions || []).map((t) => ({
        id: t.id, name: t.name, to: t.to?.name, to_category: t.to?.statusCategory?.key || null,
      }));
      if (!args.to) return { ...meta, key: args.key, transitions };
      const t = transitions.find((x) => x.id === String(args.to) || x.name.toLowerCase() === String(args.to).toLowerCase());
      if (!t) throw new Error(`no transition '${args.to}' on ${args.key}; available: ${transitions.map((x) => x.name).join(', ')}`);
      // Server-side guard: refuse to land in a forbidden statusCategory (e.g. 'done').
      // This holds even if a caller misuses the tool — the Done-guard is code, not prompt.
      if (args.forbid_category && t.to_category === args.forbid_category) {
        throw new Error(`refusing transition '${t.name}' on ${args.key}: target status '${t.to}' is in statusCategory '${t.to_category}', which is forbidden (forbid_category='${args.forbid_category}')`);
      }
      await rest(acct, 'POST', `/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`, { transition: { id: t.id } });
      return { ...meta, key: args.key, transitioned_to: t.to || t.name, to_category: t.to_category };
    }
    case 'jira_assign': {
      const { accountId, label } = await resolveAssignee(acct, args.assignee, args.key);
      await rest(acct, 'PUT', `/rest/api/3/issue/${encodeURIComponent(args.key)}/assignee`, { accountId });
      return { ...meta, key: args.key, assigned_to: label, accountId };
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
    case 'confluence_search': {
      let cql = args.cql;
      if (!cql) {
        const parts = [];
        const space = args.space || acct.mapEntry?.space;
        if (space) parts.push(`space = "${String(space).replace(/"/g, '')}"`);
        if (args.text) parts.push(`text ~ "${String(args.text).replace(/"/g, '\\"')}"`);
        if (!parts.length) throw new Error('confluence_search needs `cql`, or `text` (optionally with `space`).');
        cql = parts.join(' AND ');
      }
      const limit = args.limit || 20;
      const data = await rest(acct, 'GET', `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
      const results = (data.results || []).map((r) => {
        const c = r.content || {};
        return {
          id: c.id || r.id, type: c.type || r.entityType, title: c.title || r.title,
          space: c.space?.key || r.resultGlobalContainer?.title,
          url: r._links?.webui || r.url ? `https://${acct.site}.atlassian.net/wiki${r.url || c._links?.webui || ''}` : undefined,
          excerpt: r.excerpt || undefined,
        };
      });
      return { ...meta, cql, size: data.size ?? results.length, results };
    }
    case 'confluence_page': {
      const page = await rest(acct, 'GET', `/wiki/api/v2/pages/${encodeURIComponent(args.id)}?body-format=atlas_doc_format`);
      let body = page.body?.atlas_doc_format?.value ?? null;
      if (!args.raw && body != null) {
        let adfDoc; try { adfDoc = JSON.parse(body); } catch { adfDoc = body; }
        body = adfToMarkdown(adfDoc);
      } else if (args.raw && body != null) {
        try { body = JSON.parse(body); } catch { /* leave as string */ }
      }
      return {
        ...meta, id: page.id, title: page.title, status: page.status,
        spaceId: page.spaceId, parentId: page.parentId,
        version: page.version?.number,
        url: page._links?.webui ? `https://${acct.site}.atlassian.net/wiki${page._links.webui}` : undefined,
        body,
      };
    }
    case 'confluence_create_page': {
      let spaceId = args.spaceId;
      if (!spaceId) {
        const key = args.space || acct.mapEntry?.space;
        if (!key) throw new Error("no Confluence space: pass `space` (key) or `spaceId`, or add a space to map.env (<folder>=<account>:<PROJECT>:<SPACE>).");
        spaceId = await resolveSpaceId(acct, key);
      }
      const payload = { spaceId: String(spaceId), status: 'current', title: args.title, body: confBody(args.body) };
      if (args.parentId) payload.parentId = String(args.parentId);
      const out = await rest(acct, 'POST', '/wiki/api/v2/pages', payload);
      return {
        ...meta, id: out.id, title: out.title, spaceId: out.spaceId, version: out.version?.number,
        url: out._links?.webui ? `https://${acct.site}.atlassian.net/wiki${out._links.webui}` : undefined,
      };
    }
    case 'confluence_update_page': {
      const current = await rest(acct, 'GET', `/wiki/api/v2/pages/${encodeURIComponent(args.id)}`);
      const nextVersion = (current.version?.number || 1) + 1;
      const payload = {
        id: String(args.id), status: 'current',
        title: args.title || current.title,
        body: confBody(args.body),
        version: { number: nextVersion },
      };
      const out = await rest(acct, 'PUT', `/wiki/api/v2/pages/${encodeURIComponent(args.id)}`, payload);
      return {
        ...meta, id: out.id, title: out.title, version: out.version?.number,
        url: out._links?.webui ? `https://${acct.site}.atlassian.net/wiki${out._links.webui}` : undefined,
      };
    }
    case 'jira_link': {
      const types = await rest(acct, 'GET', '/rest/api/3/issueLinkType');
      const list = (types.issueLinkTypes || []).map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }));
      if (!args.type && !args.inward && !args.outward) {
        return { ...meta, link_types: list };
      }
      if (!args.type || !args.inward || !args.outward) {
        throw new Error('jira_link needs `type`, `inward` and `outward` to create a link (or no args to list link types).');
      }
      const want = String(args.type).toLowerCase();
      const match = list.find((t) => t.name.toLowerCase() === want)
        || list.find((t) => (t.inward || '').toLowerCase() === want || (t.outward || '').toLowerCase() === want)
        || list.find((t) => t.name.toLowerCase().includes(want));
      if (!match) throw new Error(`no link type matching '${args.type}'; available: ${list.map((t) => t.name).join(', ')}`);
      await rest(acct, 'POST', '/rest/api/3/issueLink', {
        type: { name: match.name },
        inwardIssue: { key: args.inward },
        outwardIssue: { key: args.outward },
      });
      return { ...meta, linked: true, type: match.name, inward: args.inward, outward: args.outward, meaning: `${args.outward} ${match.outward} ${args.inward}` };
    }
    case 'jira_worklog': {
      if (!args.timeSpent) {
        const wl = await rest(acct, 'GET', `/rest/api/3/issue/${encodeURIComponent(args.key)}/worklog`);
        const worklogs = (wl.worklogs || []).slice(-20).map((w) => ({
          id: w.id, author: w.author?.displayName, timeSpent: w.timeSpent,
          timeSpentSeconds: w.timeSpentSeconds, started: w.started,
          comment: w.comment ? adfToMarkdown(w.comment) : null,
        }));
        return { ...meta, key: args.key, total: wl.total ?? worklogs.length, worklogs };
      }
      const body = { timeSpent: args.timeSpent, started: worklogStarted(args.started) };
      if (args.comment) body.comment = adf(args.comment);
      const out = await rest(acct, 'POST', `/rest/api/3/issue/${encodeURIComponent(args.key)}/worklog`, body);
      return { ...meta, key: args.key, worklog_id: out.id, timeSpent: out.timeSpent, started: out.started };
    }
    case 'jira_sprints': {
      // Move mode: {sprint, issues} -> add issues to a sprint (≤50/request).
      if (args.sprint && args.issues && args.issues.length) {
        let sprintId = /^\d+$/.test(String(args.sprint)) ? String(args.sprint) : null;
        if (!sprintId) {
          const project = args.project || acct.mapEntry?.project;
          if (!project) throw new Error('resolving a sprint by name needs `project` (or a folder-mapped project).');
          const sprints = await listSprints(acct, project);
          const s = sprints.find((x) => x.name?.toLowerCase() === String(args.sprint).toLowerCase())
            || sprints.find((x) => x.name?.toLowerCase().includes(String(args.sprint).toLowerCase()));
          if (!s) throw new Error(`no active/future sprint matching '${args.sprint}' in ${project}; available: ${sprints.map((x) => x.name).join(', ') || '(none)'}`);
          sprintId = String(s.id);
        }
        const keys = args.issues;
        for (let i = 0; i < keys.length; i += 50) {
          await rest(acct, 'POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: keys.slice(i, i + 50) });
        }
        return { ...meta, sprint: sprintId, moved_count: keys.length, issues: keys };
      }
      // List mode: {project} -> boards + their active/future sprints.
      const project = args.project || acct.mapEntry?.project;
      if (!project) throw new Error("jira_sprints needs `project` (or a folder-mapped project) to list boards/sprints.");
      let boardsData;
      try {
        boardsData = await rest(acct, 'GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return { ...meta, project, boards: [], note: 'Jira Software / Agile API not available on this site (404).' };
        throw e;
      }
      const boards = boardsData.values || [];
      if (!boards.length) return { ...meta, project, boards: [], note: `no boards found for project ${project}.` };
      const out = [];
      for (const b of boards) {
        let sprints = [];
        let note;
        try {
          const sd = await rest(acct, 'GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active,future`);
          sprints = (sd.values || []).map((s) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate }));
        } catch (e) {
          note = /HTTP 400/.test(e.message) ? 'board type has no sprints (e.g. kanban)' : e.message;
        }
        out.push({ id: b.id, name: b.name, type: b.type, sprints, ...(note ? { note } : {}) });
      }
      return { ...meta, project, boards: out };
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
        serverInfo: { name: 'jira-multi', version: '1.3.0' },
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
