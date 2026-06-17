// Phase-2 spike / lab runner.
//
// Run a configured lab (uses its theme + per-role presets from data/labs.json):
//   npm run spike -- --lab=mindfulness
//   npm run spike:dry -- --lab=pennant
// Or an ad-hoc theme with default presets:
//   npm run spike:dry -- --theme=baseball

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lab } from './orchestrator.js';
import { Store } from './store.js';
import { THEMES, DEFAULT_THEME, type RoleSetting } from './themes.js';

const arg = (p: string) => process.argv.find((a) => a.startsWith(p))?.slice(p.length);
const DRY = process.argv.includes('--dry');
const labId = arg('--lab=');
const TASK =
  arg('--task=') ??
  'Draft a concise, practical plan to measure whether a 10-minute daily mindfulness routine improves focus in undergraduates.';

let theme = THEMES[arg('--theme=') ?? DEFAULT_THEME] ?? THEMES[DEFAULT_THEME];
let settings: RoleSetting[] | undefined;
let file = theme.id === DEFAULT_THEME ? 'data/graph.json' : `data/graph-${theme.id}.json`;

if (labId) {
  const labs = JSON.parse(readFileSync(join(process.cwd(), 'data', 'labs.json'), 'utf8'));
  const lab = labs.find((l: { id: string }) => l.id === labId);
  if (!lab) throw new Error(`no lab "${labId}" in data/labs.json`);
  theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];
  settings = lab.roleSettings;
  file = lab.graph;
}

async function main() {
  console.log(`\n=== Claude Lab · ${theme.name} ${DRY ? '(DRY RUN)' : '(LIVE)'} ===\n`);
  console.log(`Hierarchy: ${theme.roles.join(' → ')}`);
  if (settings) console.log('Presets: ' + settings.map((s, i) => `${theme.roles[i]}=${s.model}/${s.effort}`).join(', '));
  console.log(`Task: ${TASK}\n`);

  const store = new Store(join(process.cwd(), file));
  const lab = new Lab({ dry: DRY, theme, store, settings });

  const rootTask = store.addTask('Top-level charge', TASK);
  const lead = await lab.spawn(0, rootTask);

  console.log(`\n--- ${theme.roles[0]} final synthesis ---\n` + lead.text + '\n');

  const agents = store.nodes.filter((n) => n.type === 'agent');
  const deepest = agents[agents.length - 1];
  console.log(`=== Resume test: reopening ${deepest.title} (${deepest.id}) by session ${deepest.sessionId} ===`);
  const followUp = 'In one sentence, what was the single most important thing you produced?';
  const reply = await lab.resume(deepest.id, followUp);
  console.log(`Q: ${followUp}\nA: ${reply}\n`);

  printGraph(store);
  if (!DRY) console.log(`\nTotal cost: $${lab.totalCost.toFixed(4)}`);
  console.log(`\nPersisted to ${file} — ${agents.length} agents, ${store.nodes.length} nodes, ${store.edges.length} edges.`);
}

function printGraph(store: Store) {
  console.log('=== GRAPH (DAG) ===');
  for (const n of store.nodes) {
    const tag = n.type === 'agent' ? `🧪 ${n.title}` : `📋 ${n.title}`;
    const sess = n.sessionId ? `  session=${n.sessionId.slice(0, 8)}` : '';
    console.log(`  ${n.id.padEnd(9)} ${tag.padEnd(28)} [${n.status}]${sess}`);
  }
  console.log('  edges:');
  for (const e of store.edges) console.log(`    ${e.from} --${e.kind}--> ${e.to}`);
}

main().catch((e) => {
  console.error('\nSpike failed:', e);
  process.exit(1);
});
