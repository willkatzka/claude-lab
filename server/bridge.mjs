// Bridge server: exposes the graph, session transcripts, and per-lab settings
// to the browser (the Node-only Agent SDK can't run in the renderer).
//   GET  /api/labs                          -> [{id, name, container}]
//   GET  /api/labs/:id/graph                -> { nodes, edges }
//   GET  /api/labs/:id/settings             -> { theme, container, roles[], roleSettings[] }
//   PUT  /api/labs/:id/settings             -> persist roleSettings
//   GET  /api/sessions/:sessionId/messages  -> [{ role, text }]

import express from 'express';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getSessionMessages, query, tool, createSdkMcpServer, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { THEMES, DEFAULT_THEME } from '../src/themes.js';
import { Lab } from '../src/orchestrator.js';
import { Store } from '../src/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Writable data dir (labs.json + graph files). The packaged app overrides this
// to a user-writable location (the app bundle is read-only); defaults to the
// repo's data/ in dev.
const DATA_DIR = process.env.LAB_DATA_DIR || join(ROOT, 'data');
const LABS_FILE = join(DATA_DIR, 'labs.json');
const graphPath = (lab) => join(DATA_DIR, basename(lab.graph));

// Resilient on a fresh clone: no labs.json yet → start with an empty lab list.
const loadLabs = () => {
  try {
    return JSON.parse(readFileSync(LABS_FILE, 'utf8'));
  } catch {
    return [];
  }
};
const saveLabs = (labs) => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LABS_FILE, JSON.stringify(labs, null, 2));
};
const containerOf = (themeId) => THEMES[themeId]?.container ?? 'Lab';
// The directory a lab's agents run in (its repo/folder); falls back to the app dir.
const cwdFor = (lab) => (lab.cwd && existsSync(lab.cwd) ? lab.cwd : ROOT);
const isValidDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Lab agents run as "real" Claude Code, not a bare SDK assistant: the Claude Code
// system prompt (conversational tone + formatting) plus the user's/project's
// settings for the working dir — CLAUDE.md, project MCP servers, hooks. This makes
// an agent behave like running `claude` in that folder. The appended style note
// keeps replies conversational even when the session's own history has drifted
// into dense status-report formatting.
// 1:1 with Claude Code: the bare claude_code system prompt, no custom appends.
// Behavior at a given model/effort matches `claude` run in the working dir.
// (Lab features stay tool-level: read_log is discoverable via its own tool
// description, not via system-prompt instructions that would shape behavior.)
const CC_SYSTEM_PROMPT = { type: 'preset', preset: 'claude_code' };
const CC_SETTING_SOURCES = ['user', 'project', 'local'];
// Let agents run to completion like Claude Code — no low turn cap. This is a
// runaway backstop only (a single chat message doing 1000 tool rounds is a loop).
const CHAT_MAX_TURNS = 1000;
// Active streaming queries, keyed by `${labId}:${nodeId}` → AbortController, so a
// Stop request can abort the running agent.
const runningStreams = new Map();

// Per-turn injection is disabled for 1:1 parity with Claude Code — the user's
// message is sent verbatim. (STYLE_MARK is retained only so toChat still strips
// the marker from any older transcripts that contain it.)
const STYLE_MARK = '⟦lab:reply-style⟧';
const withStyle = (prompt) => prompt;

// When a parent delegates, it recommends how to tune the sub-agent for the task.
// Parse its <delegation-config> block → a model id + effort, and strip it from
// the plan text so it never shows in the handoff.
const DELEGATE_MODEL = { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5' };
const EFFORT_SET = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function parseDelegationTuning(text) {
  const m = /<delegation-config>([\s\S]*?)<\/delegation-config>/i.exec(text);
  if (!m) return { name: null, model: null, effort: null, clean: text };
  const body = m[1];
  const modelKey = (/model:\s*([a-z0-9.\-]+)/i.exec(body)?.[1] || '').toLowerCase();
  const effortKey = (/effort:\s*([a-z]+)/i.exec(body)?.[1] || '').toLowerCase();
  const name =
    (/name:\s*(.+)/i.exec(body)?.[1] || '')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 48) || null;
  const model = DELEGATE_MODEL[modelKey] || (modelKey.startsWith('claude-') ? modelKey : null);
  const effort = EFFORT_SET.has(effortKey) ? effortKey : null;
  return { name, model, effort, clean: text.replace(m[0], '').trim() };
}

// A short human label for a tool call, like Claude Code's activity lines
// ("Edited foo.py", "Ran a command"). Used for the live streaming timeline.
const baseName = (p) => (typeof p === 'string' ? p.split('/').pop() : '');
function toolActivity(tool, input = {}) {
  const t = String(tool || '');
  const file = baseName(input.file_path ?? input.path);
  switch (t) {
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Edited', detail: file };
    case 'Write':
      return { verb: 'Wrote', detail: file };
    case 'Read':
      return { verb: 'Read', detail: file };
    case 'Bash':
      return { verb: 'Ran a command', detail: String(input.command ?? '').split('\n')[0].slice(0, 80) };
    case 'Grep':
      return { verb: 'Searched', detail: String(input.pattern ?? '').slice(0, 60) };
    case 'Glob':
      return { verb: 'Globbed', detail: String(input.pattern ?? '').slice(0, 60) };
    case 'WebFetch':
    case 'WebSearch':
      return { verb: 'Searched the web', detail: String(input.query ?? input.url ?? '').slice(0, 60) };
    case 'TodoWrite':
      return { verb: 'Updated the plan', detail: '' };
    default:
      return { verb: `Used ${t.replace(/^mcp__/, '')}`, detail: file };
  }
}

// Append-only audit / findings log per lab (one JSON event per line).
const auditPath = (labId) => join(DATA_DIR, `audit-${labId}.jsonl`);
function appendAudit(labId, event) {
  try {
    appendFileSync(auditPath(labId), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (e) {
    console.error('audit append failed:', e.message);
  }
}

// A human-readable digest of the shared lab log — what every agent reported
// and did — for the read_log tool.
function auditDigest(labId, limit = 80) {
  const file = auditPath(labId);
  if (!existsSync(file)) return 'The shared lab log is empty.';
  const events = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-limit);
  if (!events.length) return 'The shared lab log is empty.';
  return events
    .map((e) => {
      const t = (e.ts || '').slice(11, 19);
      switch (e.type) {
        case 'finding':
          return `[${t}] ${e.role} FINDING: ${(e.text || '').slice(0, 900)}`;
        case 'delegate':
          return `[${t}] ${e.role} delegated: ${(e.brief || '').slice(0, 200)}`;
        case 'spawn':
          return `[${t}] ${e.role} spawned (${e.model}/${e.effort}) on "${e.task || ''}"`;
        case 'tool':
          return `[${t}] ${e.role || e.agentId} used ${e.tool}${e.target ? ' on ' + e.target : ''}`;
        case 'message':
          return `[${t}] ${e.role} chat: "${(e.text || '').slice(0, 160)}" → ${(e.reply || '').slice(0, 900)}`;
        case 'handoff':
          return `[${t}] ${e.role} wrote a handoff: ${(e.brief || '').slice(0, 140)}`;
        case 'rewind':
          return `[${t}] ${e.role} rewound the conversation`;
        case 'branch':
          return `[${t}] ${e.role} branched the conversation`;
        case 'terminal':
          return `[${t}] ${e.role} opened in terminal`;
        default:
          return `[${t}] ${e.type} ${e.role || ''}`;
      }
    })
    .join('\n');
}

// An in-process tool that lets an agent read the shared lab log on demand.
const readLogServer = (labId) =>
  createSdkMcpServer({
    name: 'lab',
    tools: [
      tool(
        'read_log',
        'Read the shared lab log: findings reported by every agent in this lab plus a trail of who did what. Call this to catch up on teammates’ work before answering.',
        { limit: z.number().optional().describe('max recent events to read') },
        async (args) => ({ content: [{ type: 'text', text: auditDigest(labId, args.limit ?? 80) }] }),
      ),
    ],
  });

const app = express();
app.use(express.json());

app.get('/api/labs', (_req, res) =>
  res.json(loadLabs().map((l) => ({ id: l.id, name: l.name, container: containerOf(l.theme), cwd: l.cwd || '' }))),
);

app.get('/api/themes', (_req, res) =>
  res.json(
    Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, container: t.container, roles: t.roles })),
  ),
);

app.get('/api/labs/:id/graph', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const file = graphPath(lab);
  if (!existsSync(file)) return res.json({ nodes: [], edges: [] });
  try {
    res.json(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // The file may be mid-write during a live run; treat as transiently empty.
    res.json({ nodes: [], edges: [] });
  }
});

// Delete a lab: remove it from labs.json and delete its graph + audit files.
// (Leaves the underlying Claude sessions in ~/.claude untouched.)
app.delete('/api/labs/:id', (req, res) => {
  const labs = loadLabs();
  const lab = labs.find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  for (const f of [graphPath(lab), auditPath(lab.id)]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch (e) {
      console.error('delete file failed:', e.message);
    }
  }
  saveLabs(labs.filter((l) => l.id !== req.params.id));
  res.json({ deleted: true });
});

const loadGraph = (lab) => {
  const f = graphPath(lab);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { nodes: [], edges: [] };
};
const saveGraph = (lab, g) => writeFileSync(graphPath(lab), JSON.stringify(g, null, 2));

// Rename a lab.
app.patch('/api/labs/:id', (req, res) => {
  const labs = loadLabs();
  const lab = labs.find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const { name, cwd, theme } = req.body ?? {};
  if (typeof name === 'string' && name.trim()) lab.name = name.trim();
  if (typeof cwd === 'string') {
    if (cwd && !isValidDir(cwd)) return res.status(400).json({ error: `working directory not found: ${cwd}` });
    lab.cwd = cwd;
  }
  // Switch the lab's hierarchy theme and relabel existing agents to the new role
  // names for their rank (custom names are preserved).
  if (typeof theme === 'string' && THEMES[theme] && theme !== lab.theme) {
    lab.theme = theme;
    try {
      const g = loadGraph(lab);
      const roles = THEMES[theme].roles;
      let changed = false;
      for (const n of g.nodes) {
        if (n.type === 'agent' && n.rank != null && roles[n.rank]) {
          n.title = roles[n.rank];
          n.role = `${theme}:${n.rank}`;
          changed = true;
        }
      }
      if (changed) saveGraph(lab, g);
    } catch (e) {
      console.error('theme relabel failed:', e.message);
    }
  }
  saveLabs(labs);
  res.json({ ok: true, name: lab.name, cwd: lab.cwd || '', theme: lab.theme });
});

// Edit a node's title / description.
app.patch('/api/labs/:id/nodes/:nodeId', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const g = loadGraph(lab);
  const node = g.nodes.find((n) => n.id === req.params.nodeId);
  if (!node) return res.status(404).json({ error: 'no such node' });
  const { title, description, model, effort, name } = req.body ?? {};
  if (typeof title === 'string') node.title = title;
  if (typeof description === 'string') node.description = description;
  if (typeof model === 'string') node.model = model;
  if (typeof effort === 'string') node.effort = effort;
  if (typeof name === 'string') node.name = name;
  saveGraph(lab, g);
  res.json({ ok: true, node });
});

// Delete a node and everything beneath it (its subtree).
app.delete('/api/labs/:id/nodes/:nodeId', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const g = loadGraph(lab);
  if (!g.nodes.some((n) => n.id === req.params.nodeId)) return res.status(404).json({ error: 'no such node' });
  const doomed = new Set();
  const stack = [req.params.nodeId];
  while (stack.length) {
    const id = stack.pop();
    if (doomed.has(id)) continue;
    doomed.add(id);
    for (const e of g.edges) if (e.from === id && !doomed.has(e.to)) stack.push(e.to);
  }
  g.nodes = g.nodes.filter((n) => !doomed.has(n.id));
  g.edges = g.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to));
  saveGraph(lab, g);
  res.json({ deleted: doomed.size });
});

// Audit / findings log for a lab (chronological events).
app.get('/api/labs/:id/audit', (req, res) => {
  const file = auditPath(req.params.id);
  if (!existsSync(file)) return res.json([]);
  try {
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json(events);
  } catch {
    res.json([]);
  }
});

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lab';

// Runs/delegations execute IN-PROCESS (fire-and-forget) — same context as the
// working live-message/account query() calls. Child processes hung; this
// doesn't. The graph persists incrementally so the UI polls progress.
function runLabInProcess(lab, task, dry) {
  (async () => {
    const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];
    const store = new Store(graphPath(lab));
    const orch = new Lab({ dry, theme, store, settings: lab.roleSettings, onEvent: (e) => appendAudit(lab.id, e), cwd: cwdFor(lab) });
    const root = store.addTask('Top-level charge', task);
    // Manual mode: spawn ONLY the lead (no auto-cascade / auto-named tasks).
    // The user builds the rest of the hierarchy via the ＋ / Delegate controls.
    await orch.spawn(0, root, '', { noDelegate: true });
  })().catch((e) => console.error('run failed:', e));
}

// Delegation handoff protocol: parent writes a plan → HANDOFF.md in the repo →
// sub-agent confirms the plan and PAUSES for your approval before doing the work.
function delegateInProcess(lab, parentNodeId, brief) {
  (async () => {
    const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];
    let store = Store.open(graphPath(lab));
    const parent = store.nodes.find((n) => n.id === parentNodeId);
    if (!parent || parent.type !== 'agent') throw new Error('parent must be an agent node');
    const childRank = (parent.rank ?? 0) + 1;
    if (childRank >= theme.roles.length) throw new Error('leaf agents cannot delegate');
    const childRole = theme.roles[childRank];

    // 1) Parent writes the handoff plan.
    parent.status = 'running';
    store.persist();
    const planPrompt =
      `You're delegating this task to your ${childRole}:\n\n"${brief}"\n\n` +
      `Write a SHORT handoff plan — comprehensive but terse (aim for ~120 words total). Use EXACTLY this template, in this order, ` +
      `and nothing else: no preamble, no "##" headings, no nested sub-bullets, no extra sections.\n\n` +
      `**Goal:** one sentence — what to accomplish.\n` +
      `**Approach:** 2–4 short bullets — how (include any critical do/don't).\n` +
      `**Files read:** comma-separated paths, or "—".\n` +
      `**Files changed:** each path + the change in a few words, or "None".\n` +
      `**Guardrails:** hard limits (e.g. don't deploy, don't touch X), or "—".\n\n` +
      `Then set up the ${childRole}: a short Title Case name (2–4 words naming the work), and model+effort matched to it — ` +
      `heavy reasoning/coding/open-ended → opus high|xhigh; moderate → sonnet medium|high; simple/quick → haiku low|medium. ` +
      `End with exactly this block and nothing after it:\n` +
      `<delegation-config>\nname: <2-4 word Title Case task name>\nmodel: opus | sonnet | haiku\neffort: low | medium | high | xhigh | max\n</delegation-config>`;
    const plan = await agentTurn(lab, parent, planPrompt);
    const tuning = parseDelegationTuning(plan.reply);
    const planText = tuning.clean; // plan with the config block stripped, for the handoff

    // 2) Create the task + child node, named + tuned per the parent's recommendation.
    store = Store.open(graphPath(lab));
    const p2 = store.nodes.find((n) => n.id === parentNodeId);
    if (p2) {
      if (plan.sessionId) p2.sessionId = plan.sessionId;
      p2.status = 'done';
    }
    const task = store.addTask(tuning.name || `Handoff · ${childRole}`, brief);
    store.addEdge(parentNodeId, task.id, 'delegates');
    const child = store.addAgent(`${theme.id}:${childRank}`, childRole, brief, childRank);
    if (tuning.name) child.name = tuning.name;
    if (tuning.model) child.model = tuning.model;
    if (tuning.effort) child.effort = tuning.effort;
    store.addEdge(task.id, child.id, 'assigned');
    store.persist();
    if (tuning.model || tuning.effort)
      appendAudit(lab.id, {
        type: 'finding',
        agentId: child.id,
        role: childRole,
        text: `Tuned by ${parent.title}: ${tuning.model ?? 'default model'} / ${tuning.effort ?? 'default'} effort`,
      });

    // 3) Write the parent's plan to HANDOFF.md in the working directory.
    let handoffPath = '';
    try {
      const labDir = join(cwdFor(lab), '.claudelab');
      const dir = join(labDir, 'handoffs');
      mkdirSync(dir, { recursive: true });
      // Keep these scratch artifacts out of the user's git repo.
      const gi = join(labDir, '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, '*\n');
      handoffPath = join(dir, `${child.id}.md`);
      writeFileSync(
        handoffPath,
        `# Handoff → ${childRole}\n\n_Delegated by ${parent.title}_\n\n## Task\n${brief}\n\n## Plan\n${planText}\n`,
      );
    } catch (e) {
      console.error('write handoff failed:', e.message);
    }
    appendAudit(lab.id, { type: 'handoff', agentId: parentNodeId, role: parent.title, target: handoffPath, brief });

    // 4) Sub-agent confirms the plan, then PAUSES for approval.
    const confirmPrompt =
      `A task was delegated to you${handoffPath ? ` (full handoff at \`${handoffPath}\`)` : ''}. ` +
      `Confirm it back in EXACTLY this short format — comprehensive but terse (~80 words), no "##" headings, no preamble — ` +
      `then STOP and wait for approval. Do NOT start the work yet.\n\n` +
      `**Doing:** one sentence restating the goal in your own words.\n` +
      `**Files I'll read:** comma-separated, or "—".\n` +
      `**Files I'll change:** path + the change, or "None".\n` +
      `**Flags:** only real blockers or open questions as short bullets, or "None — ready".\n\n` +
      `Make the last line exactly: Approve to proceed?\n\n---\n# Task\n${brief}\n\n# Plan\n${planText}`;
    const confirm = await agentTurn(lab, child, confirmPrompt);

    store = Store.open(graphPath(lab));
    const c2 = store.nodes.find((n) => n.id === child.id);
    if (c2) {
      if (confirm.sessionId) c2.sessionId = confirm.sessionId;
      c2.status = 'waiting'; // awaiting your approval
      if (handoffPath) c2.handoff = handoffPath;
    }
    store.persist();
    appendAudit(lab.id, {
      type: 'finding',
      agentId: child.id,
      role: childRole,
      text: 'Confirmed plan (awaiting approval): ' + confirm.reply.slice(0, 400),
    });
  })().catch((e) => console.error('delegate handoff failed:', e));
}

// Add another IDLE agent to an existing task/project node (many agents per task).
// It's a blank chat until you message it — nothing auto-runs.
function assignInProcess(lab, taskNodeId) {
  try {
    const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];
    const store = Store.open(graphPath(lab));
    const task = store.nodes.find((n) => n.id === taskNodeId && n.type === 'task');
    if (!task) throw new Error('not a task node');
    // Match the rank of an agent already on this task, else the delegator's rank+1.
    let rank;
    const peer = store.edges.find((e) => e.kind === 'assigned' && e.from === task.id);
    if (peer) rank = store.nodes.find((n) => n.id === peer.to)?.rank ?? 0;
    else {
      const delg = store.edges.find((e) => e.kind === 'delegates' && e.to === task.id);
      const parent = delg && store.nodes.find((n) => n.id === delg.from);
      rank = (parent?.rank ?? -1) + 1;
    }
    if (rank == null || rank < 0 || rank >= theme.roles.length) rank = theme.roles.length - 1;
    const agent = store.addAgent(`${theme.id}:${rank}`, theme.roles[rank], task.description, rank);
    agent.status = 'waiting';
    store.addEdge(task.id, agent.id, 'assigned');
    store.persist();
  } catch (e) {
    console.error('assign failed:', e.message);
  }
}

// Sensible default presets: richer model at the top, cheaper toward the leaf.
const DEFAULT_PRESETS = [
  { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' },
  { model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions' },
  { model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions' },
  { model: 'sonnet', effort: 'low', permissionMode: 'bypassPermissions' },
  { model: 'haiku', effort: 'low', permissionMode: 'bypassPermissions' },
];

// Global app settings: the default hierarchy + default Claude settings new labs use.
const SETTINGS_FILE = join(DATA_DIR, 'app-settings.json');
function loadAppSettings() {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return { defaultTheme: s.defaultTheme || DEFAULT_THEME, defaultPresets: s.defaultPresets || DEFAULT_PRESETS };
  } catch {
    return { defaultTheme: DEFAULT_THEME, defaultPresets: DEFAULT_PRESETS };
  }
}

app.get('/api/settings', (_req, res) => res.json(loadAppSettings()));
app.put('/api/settings', (req, res) => {
  const cur = loadAppSettings();
  const { defaultTheme, defaultPresets } = req.body ?? {};
  if (defaultTheme && THEMES[defaultTheme]) cur.defaultTheme = defaultTheme;
  if (Array.isArray(defaultPresets) && defaultPresets.length === 5) cur.defaultPresets = defaultPresets;
  writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));
  res.json(cur);
});

// Create a new lab (organization) from a name + theme.
app.post('/api/labs', (req, res) => {
  const { name, theme, cwd, charge } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (cwd && !isValidDir(cwd)) return res.status(400).json({ error: `working directory not found: ${cwd}` });
  // Hierarchy + presets default to the global settings (overridable per request).
  const settings = loadAppSettings();
  const useTheme = theme && THEMES[theme] ? theme : settings.defaultTheme;
  const presets = Array.isArray(settings.defaultPresets) ? settings.defaultPresets : DEFAULT_PRESETS;
  const labs = loadLabs();
  let id = slugify(name);
  let n = 1;
  while (labs.some((l) => l.id === id)) id = `${slugify(name)}-${++n}`;
  const lab = { id, name, theme: useTheme, cwd: cwd || '', graph: `data/graph-${id}.json`, roleSettings: presets };
  labs.push(lab);
  saveLabs(labs);
  // Seed the graph with a root task + an IDLE lead agent (no session). Nothing
  // auto-runs — the lead is a blank chat until the user messages it.
  try {
    const store = new Store(graphPath(lab));
    const root = store.addTask('Top-level charge', (charge && charge.trim()) || `Objectives for ${name}`);
    root.status = 'waiting';
    const lead = store.addAgent(`${useTheme}:0`, THEMES[useTheme].roles[0], root.description, 0);
    lead.status = 'waiting';
    store.addEdge(root.id, lead.id, 'assigned');
    store.persist();
  } catch (e) {
    console.error('seed graph failed:', e.message);
  }
  res.json({ id, name, container: containerOf(useTheme) });
});

// Kick off a live (or dry) run for a lab. Runs as a detached child process that
// writes the graph incrementally; the UI polls /graph to watch it build.
app.post('/api/labs/:id/run', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const task = req.body?.task || 'Plan and deliver the objective.';
  const dry = !!req.body?.dry;
  runLabInProcess(lab, task, dry);
  res.json({ started: true, dry });
});

// Interactive delegation: spawn a new child node under an existing agent.
app.post('/api/labs/:id/delegate', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const { parentNodeId, brief } = req.body ?? {};
  if (!parentNodeId || !brief) return res.status(400).json({ error: 'parentNodeId and brief required' });
  delegateInProcess(lab, parentNodeId, brief);
  res.json({ started: true });
});

// Add another agent to an existing task/project node.
app.post('/api/labs/:id/assign', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const { taskNodeId } = req.body ?? {};
  if (!taskNodeId) return res.status(400).json({ error: 'taskNodeId required' });
  assignInProcess(lab, taskNodeId);
  res.json({ started: true });
});

// Account + usage (the /usage panel data). Cached briefly; one tiny query.
let accountCache = null;
let accountCacheAt = 0;
app.get('/api/account', async (req, res) => {
  if (accountCache && Date.now() - accountCacheAt < 30000) return res.json(accountCache);
  try {
    const q = query({
      prompt: 'ping',
      options: { model: 'haiku', maxTurns: 1, allowedTools: [], permissionMode: 'bypassPermissions', settingSources: [], cwd: ROOT },
    });
    const account = await q.accountInfo();
    let usage = null;
    try {
      usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    } catch {
      /* experimental — may be unavailable */
    }
    try {
      await q.return?.(undefined);
    } catch {
      /* ignore */
    }
    accountCache = { account, usage };
    accountCacheAt = Date.now();
    res.json(accountCache);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get('/api/labs/:id/settings', (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const theme = THEMES[lab.theme];
  res.json({
    theme: lab.theme,
    themeName: theme?.name ?? lab.theme,
    container: theme?.container ?? 'Lab',
    roles: theme?.roles ?? [],
    roleSettings: lab.roleSettings,
  });
});

app.put('/api/labs/:id/settings', (req, res) => {
  const labs = loadLabs();
  const lab = labs.find((l) => l.id === req.params.id);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  if (!Array.isArray(req.body?.roleSettings)) return res.status(400).json({ error: 'roleSettings[] required' });
  lab.roleSettings = req.body.roleSettings;
  saveLabs(labs);
  res.json({ ok: true, roleSettings: lab.roleSettings });
});

// Locate which lab + node owns a sessionId, so we can apply the right per-role
// preset (model / effort / permission) when resuming.
function findNodeBySession(sessionId) {
  for (const lab of loadLabs()) {
    const file = graphPath(lab);
    if (!existsSync(file)) continue;
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    const node = graph.nodes.find((n) => n.sessionId === sessionId);
    if (node) return { lab, node };
  }
  return null;
}

const DEFAULT_SETTING = { model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions' };

function extractText(message) {
  return (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// One agent turn: resume the node's session, or start a fresh one. Returns the
// reply + session id. Tool/file use is logged to the audit.
async function agentTurn(lab, node, prompt) {
  const setting = lab.roleSettings?.[node.rank ?? 0] ?? DEFAULT_SETTING;
  const resuming = node.sessionId && !String(node.sessionId).startsWith('mock-');
  const permissionMode = setting.permissionMode === 'default' ? 'bypassPermissions' : setting.permissionMode;
  const preToolUse = async (input) => {
    const t = input?.tool_name;
    const ti = input?.tool_input ?? {};
    if (t && t !== 'mcp__lab__read_log') {
      appendAudit(lab.id, { type: 'tool', agentId: node.id, role: node.title, tool: t, target: ti.file_path ?? ti.path ?? ti.command ?? '' });
    }
    return { continue: true };
  };
  let reply = '';
  let sessionId = resuming ? node.sessionId : '';
  const q = query({
    prompt,
    options: {
      ...(resuming ? { resume: node.sessionId } : {}),
      cwd: cwdFor(lab),
      model: node.model || setting.model,
      effort: node.effort || setting.effort,
      permissionMode,
      systemPrompt: CC_SYSTEM_PROMPT,
      mcpServers: { lab: readLogServer(lab.id) },
      maxTurns: CHAT_MAX_TURNS,
      settingSources: CC_SETTING_SOURCES,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    },
  });
  for await (const m of q) {
    if (m.session_id) sessionId = m.session_id;
    if (m.type === 'assistant') reply += extractText(m.message);
    if (m.type === 'result' && m.subtype === 'success') reply = m.result;
  }
  return { reply: reply.trim(), sessionId };
}

// Live messaging: resume an agent's session with a new prompt and return its reply.
app.post('/api/sessions/:sessionId/message', async (req, res) => {
  const sessionId = req.params.sessionId;
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt required' });
  }
  if (sessionId.startsWith('mock-')) {
    return res.status(400).json({ error: 'This is a demo (mock) session — run the lab live to chat.' });
  }

  const found = findNodeBySession(sessionId);
  const setting = found?.lab?.roleSettings?.[found.node.rank ?? 0] ?? DEFAULT_SETTING;

  try {
    let reply = '';
    // Give the agent the read_log tool so it can pull the shared lab log
    // (teammates' findings) into its reasoning on demand. Allowlisted → no prompt.
    const mcpServers = found ? { lab: readLogServer(found.lab.id) } : undefined;
    const allowedTools = found ? ['mcp__lab__read_log'] : [];
    const q = query({
      prompt: withStyle(prompt),
      options: {
        resume: sessionId,
        cwd: found ? cwdFor(found.lab) : ROOT,
        model: setting.model,
        effort: setting.effort,
        permissionMode: setting.permissionMode,
        systemPrompt: CC_SYSTEM_PROMPT,
        mcpServers,
        allowedTools,
        maxTurns: CHAT_MAX_TURNS,
        settingSources: CC_SETTING_SOURCES,
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        const blocks = m.message?.content ?? [];
        reply += blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
      if (m.type === 'result' && m.subtype === 'success') reply = m.result;
    }
    if (found) {
      appendAudit(found.lab.id, {
        type: 'message',
        agentId: found.node.id,
        role: found.node.title,
        text: prompt,
        reply: reply.trim().slice(0, 2000),
      });
    }
    res.json({ reply: reply.trim(), model: setting.model });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Chat with an agent by node id. Starts a fresh Claude Code session on the
// first message (a generic chat rooted in the lab's working dir), resumes it
// after. No auto-prompt — the conversation is whatever the user sends.
app.post('/api/labs/:labId/nodes/:nodeId/message', async (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });
  const g = loadGraph(lab);
  const node = g.nodes.find((n) => n.id === req.params.nodeId);
  if (!node || node.type !== 'agent') return res.status(404).json({ error: 'no such agent node' });

  node.status = 'running';
  saveGraph(lab, g);
  try {
    const { reply, sessionId } = await agentTurn(lab, node, withStyle(prompt));
    const g2 = loadGraph(lab);
    const n2 = g2.nodes.find((n) => n.id === req.params.nodeId);
    if (n2) {
      if (sessionId) n2.sessionId = sessionId;
      n2.status = 'done';
      saveGraph(lab, g2);
    }
    appendAudit(lab.id, { type: 'message', agentId: node.id, role: node.title, text: prompt, reply: reply.slice(0, 2000) });
    res.json({ reply, sessionId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Streaming chat: same as the message endpoint above, but streams the reply as it
// forms — NDJSON lines ({type:'delta'|'tool'|'done'|'error'}) — so the UI shows the
// text appearing token-by-token, like the terminal / this very chat.
app.post('/api/labs/:labId/nodes/:nodeId/message/stream', async (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const userPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  // Pasted/attached images: [{ mediaType, data(base64) }]. Either text or an image required.
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.filter((a) => a?.data && a?.mediaType) : [];
  if (!userPrompt.trim() && attachments.length === 0) return res.status(400).json({ error: 'prompt or attachment required' });
  const g = loadGraph(lab);
  const node = g.nodes.find((n) => n.id === req.params.nodeId);
  if (!node || node.type !== 'agent') return res.status(404).json({ error: 'no such agent node' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch {
      /* client gone */
    }
  };

  node.status = 'running';
  saveGraph(lab, g);

  const setting = lab.roleSettings?.[node.rank ?? 0] ?? DEFAULT_SETTING;
  const resuming = node.sessionId && !String(node.sessionId).startsWith('mock-');
  const permissionMode = setting.permissionMode === 'default' ? 'bypassPermissions' : setting.permissionMode;
  // The PreToolUse hook fires with the FULL tool input — emit a rich activity
  // line to the stream (and log it) right as the agent reaches for each tool.
  const preToolUse = async (input) => {
    const t = input?.tool_name;
    const ti = input?.tool_input ?? {};
    if (t && t !== 'mcp__lab__read_log') {
      const { verb, detail } = toolActivity(t, ti);
      send({ type: 'tool', tool: t, verb, detail });
      appendAudit(lab.id, { type: 'tool', agentId: node.id, role: node.title, tool: t, target: ti.file_path ?? ti.path ?? ti.command ?? '' });
    }
    return { continue: true };
  };

  let reply = '';
  let acc = '';
  let outTokens = 0;
  let sessionId = resuming ? node.sessionId : '';
  // Register an AbortController so a Stop request can halt this run.
  const streamKey = `${req.params.labId}:${req.params.nodeId}`;
  const ac = new AbortController();
  runningStreams.set(streamKey, ac);
  let stopped = false;
  // With attachments, the prompt must be a structured user message (text + image
  // blocks) yielded as a one-shot async stream; otherwise a plain string.
  const styled = withStyle(userPrompt || 'Take a look at the attached image(s).');
  const promptArg = attachments.length
    ? (async function* () {
        yield {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: styled },
              ...attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } })),
            ],
          },
        };
      })()
    : styled;
  try {
    const q = query({
      prompt: promptArg,
      options: {
        ...(resuming ? { resume: node.sessionId } : {}),
        abortController: ac,
        cwd: cwdFor(lab),
        model: node.model || setting.model,
        effort: node.effort || setting.effort,
        permissionMode,
        systemPrompt: CC_SYSTEM_PROMPT,
        mcpServers: { lab: readLogServer(lab.id) },
        maxTurns: CHAT_MAX_TURNS,
        settingSources: CC_SETTING_SOURCES,
        includePartialMessages: true,
        hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      },
    });
    for await (const m of q) {
      if (m.session_id) sessionId = m.session_id;
      if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          acc += ev.delta.text;
          send({ type: 'delta', text: ev.delta.text });
        } else if (ev?.type === 'message_delta' && ev.usage?.output_tokens != null) {
          outTokens += ev.usage.output_tokens;
          send({ type: 'usage', output: outTokens });
        }
      } else if (m.type === 'result' && m.subtype === 'success') {
        reply = m.result;
        if (typeof m.usage?.output_tokens === 'number') outTokens = m.usage.output_tokens;
      }
    }
  } catch (e) {
    if (ac.signal.aborted) stopped = true;
    else send({ type: 'error', error: String(e?.message ?? e) });
  }
  runningStreams.delete(streamKey);
  // Finalize — commit whatever was produced (partial on stop) and mark done.
  reply = (reply || acc).trim();
  try {
    const g2 = loadGraph(lab);
    const n2 = g2.nodes.find((n) => n.id === req.params.nodeId);
    if (n2) {
      if (sessionId) n2.sessionId = sessionId;
      n2.status = 'done';
      saveGraph(lab, g2);
    }
    if (reply) appendAudit(lab.id, { type: 'message', agentId: node.id, role: node.title, text: userPrompt, reply: reply.slice(0, 2000) });
  } catch {
    /* ignore */
  }
  send({ type: 'done', reply, sessionId, output: outTokens, stopped });
  res.end();
});

// Stop a running agent turn (Stop button / Escape) by aborting its query.
app.post('/api/labs/:labId/nodes/:nodeId/stop', (req, res) => {
  const ac = runningStreams.get(`${req.params.labId}:${req.params.nodeId}`);
  if (ac) {
    ac.abort();
    res.json({ stopped: true });
  } else {
    res.json({ stopped: false });
  }
});

// Rewind (edit & resend): drop one of your messages and everything after it so
// you can re-send an edited version. `uuid` is the message to keep history UP TO
// — i.e. the message just BEFORE the one you're editing. '' resets to a blank
// session (you're editing the very first message). Forking gives a clean slice.
app.post('/api/labs/:labId/nodes/:nodeId/rewind', async (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const { uuid } = req.body ?? {};
  const g = loadGraph(lab);
  const node = g.nodes.find((n) => n.id === req.params.nodeId);
  if (!node || node.type !== 'agent') return res.status(404).json({ error: 'no such agent node' });
  if (!node.sessionId || String(node.sessionId).startsWith('mock-'))
    return res.status(400).json({ error: 'no live session to rewind' });
  try {
    let sessionId = null;
    if (uuid) ({ sessionId } = await forkSession(node.sessionId, { dir: cwdFor(lab), upToMessageId: uuid }));
    node.sessionId = sessionId; // null => the next message starts a fresh session
    saveGraph(lab, g);
    appendAudit(lab.id, { type: 'rewind', agentId: node.id, role: node.title });
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Branch (re-ask in a new agent): fork history UP TO `uuid` (the message before
// the turn you're branching from; '' => blank) into a new sibling agent, then
// re-ask `prompt` there so it answers independently. The original is untouched.
app.post('/api/labs/:labId/nodes/:nodeId/branch', async (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const { uuid, prompt } = req.body ?? {};
  const store = Store.open(graphPath(lab));
  const node = store.nodes.find((n) => n.id === req.params.nodeId);
  if (!node || node.type !== 'agent') return res.status(404).json({ error: 'no such agent node' });
  if (!node.sessionId || String(node.sessionId).startsWith('mock-'))
    return res.status(400).json({ error: 'no live session to branch' });
  try {
    let sessionId = null;
    if (uuid) ({ sessionId } = await forkSession(node.sessionId, { dir: cwdFor(lab), upToMessageId: uuid }));
    const rank = node.rank ?? 0;
    const branch = store.addAgent(node.role ?? `${lab.theme}:${rank}`, `${node.title} (branch)`, node.description, rank);
    branch.sessionId = sessionId;
    branch.status = prompt ? 'running' : 'done';
    if (node.model) branch.model = node.model;
    // Hang the branch off the same parent task as the original, if any.
    const parentEdge = store.edges.find((e) => e.kind === 'assigned' && e.to === node.id);
    if (parentEdge) store.addEdge(parentEdge.from, branch.id, 'assigned');
    store.persist();
    appendAudit(lab.id, { type: 'branch', agentId: node.id, role: node.title, target: branch.id });
    res.json({ ok: true, nodeId: branch.id });
    // Re-ask the (possibly edited) prompt in the branch so it answers on its own.
    if (prompt && typeof prompt === 'string') {
      (async () => {
        try {
          const { reply, sessionId: sid } = await agentTurn(lab, branch, withStyle(prompt));
          const s2 = Store.open(graphPath(lab));
          const b2 = s2.nodes.find((n) => n.id === branch.id);
          if (b2) {
            if (sid) b2.sessionId = sid;
            b2.status = 'done';
          }
          s2.persist();
          appendAudit(lab.id, { type: 'message', agentId: branch.id, role: branch.title, text: prompt, reply: reply.slice(0, 2000) });
        } catch (e) {
          console.error('branch turn failed:', e.message);
        }
      })();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Suggest delegatable follow-up tasks from an agent's latest reply. A cheap Haiku
// pass extracts concrete next-steps the agent proposed, so the UI can offer
// one-click "Deploy <next role> to do X" buttons. Returns the child role too.
app.post('/api/labs/:labId/nodes/:nodeId/suggest', async (req, res) => {
  const lab = loadLabs().find((l) => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'no such lab' });
  const text = req.body?.text;
  const g = loadGraph(lab);
  const node = g.nodes.find((n) => n.id === req.params.nodeId);
  if (!node || node.type !== 'agent') return res.status(404).json({ error: 'no such agent node' });
  const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];
  const childRank = (node.rank ?? 0) + 1;
  const childRole = childRank < theme.roles.length ? theme.roles[childRank] : null;
  if (!childRole || typeof text !== 'string' || !text.trim()) return res.json({ childRole, suggestions: [] });
  try {
    const prompt =
      `Below is a message an AI teammate just wrote. Extract up to 4 concrete, self-contained follow-up tasks it proposes or clearly implies — each something you could hand to a teammate to carry out independently. ` +
      `Each task is a short imperative under 12 words (no numbering, no "we should"). Skip vague musings, recaps, and questions to the user; only real, actionable next steps. ` +
      `Reply with ONLY strict JSON: {"tasks":["...","..."]} — an empty array if there are none.\n\n---\n` +
      text.slice(0, 6000);
    let out = '';
    const q = query({
      prompt,
      options: { model: 'haiku', maxTurns: 1, allowedTools: [], permissionMode: 'bypassPermissions', settingSources: [], cwd: ROOT },
    });
    for await (const m of q) {
      if (m.type === 'assistant') out += extractText(m.message);
      if (m.type === 'result' && m.subtype === 'success') out = m.result;
    }
    let tasks = [];
    const jm = /\{[\s\S]*\}/.exec(out);
    if (jm) {
      try {
        tasks = JSON.parse(jm[0]).tasks ?? [];
      } catch {
        /* not JSON */
      }
    }
    tasks = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().replace(/^[-*\d.\s]+/, ''))
      .slice(0, 4);
    res.json({ childRole, suggestions: tasks });
  } catch {
    res.json({ childRole, suggestions: [] });
  }
});

// Open (or re-open) an agent's session in a real terminal via `claude --resume`.
// There's no way to detect a closed terminal, so this always launches a fresh
// one resuming the same session — which is exactly the "reopen" behavior.
app.post('/api/sessions/:sessionId/terminal', (req, res) => {
  const id = req.params.sessionId;
  if (!id || id.startsWith('mock-') || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return res.status(400).json({ error: 'no live session for this node (run the lab live first)' });
  }
  if (process.platform !== 'darwin') {
    return res.status(400).json({ error: 'Open in terminal currently supports macOS.' });
  }
  // cd to the lab's working directory (where the session was created) so
  // `claude --resume` finds it and the terminal lands in the right repo.
  const found = findNodeBySession(id);
  const cwd = found ? cwdFor(found.lab) : ROOT;
  const shellCmd = `cd '${cwd}' && claude --resume ${id}`;
  const script = `tell application "Terminal"\n  activate\n  do script "${shellCmd}"\nend tell`;
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.error('open-in-terminal failed:', err.message);
  });
  if (found) appendAudit(found.lab.id, { type: 'terminal', agentId: found.node.id, role: found.node.title });
  res.json({ opened: true });
});

function toChat(m) {
  const role = m.role ?? m.type ?? 'assistant';
  const content = m?.message?.content ?? m?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  // Strip the hidden per-turn style reminder so it never shows in the transcript.
  const cut = text.indexOf(STYLE_MARK);
  if (cut !== -1) text = text.slice(0, cut).trimEnd();
  // m.uuid is present for transcript messages (getSessionMessages) — needed to
  // target a specific message for rewind/branch.
  return { role, text, uuid: m.uuid };
}

// A session's transcript lives under its run cwd (the lab's working dir), not
// ROOT — find the lab that owns this session and read from its cwd.
function cwdForSession(sessionId) {
  try {
    for (const lab of loadLabs()) {
      const store = Store.open(graphPath(lab));
      if (store.nodes.some((n) => n.sessionId === sessionId)) return cwdFor(lab);
    }
  } catch {
    /* ignore */
  }
  return ROOT;
}

app.get('/api/sessions/:sessionId/messages', async (req, res) => {
  try {
    const dir = cwdForSession(req.params.sessionId);
    const msgs = await getSessionMessages(req.params.sessionId, { dir });
    res.json(msgs.map(toChat).filter((m) => m.text));
  } catch {
    res.json([]);
  }
});

// Serve the built UI (production / Electron). In dev the Vite server is used
// instead and proxies /api here. Keep this AFTER all /api routes.
const uiDist = join(ROOT, 'ui', 'dist');
if (existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(uiDist, 'index.html'));
  });
}

app.listen(8787, () => console.log('Claude Lab bridge → http://localhost:8787'));
