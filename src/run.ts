// Headless lab runner spawned by the bridge for "New Lab" / re-runs.
// Builds the hierarchy for a lab (from data/labs.json), persisting the graph
// incrementally so the UI can watch nodes appear (live status).
//
//   tsx src/run.ts --lab=<id> --task="..."   [--dry]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lab } from './orchestrator.js';
import { Store } from './store.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

const arg = (p: string) => process.argv.find((a) => a.startsWith(p))?.slice(p.length);
const DRY = process.argv.includes('--dry');
const labId = arg('--lab=');
const TASK = arg('--task=') ?? 'Plan and deliver the objective.';

if (!labId) {
  console.error('run.ts requires --lab=<id>');
  process.exit(1);
}

const labs = JSON.parse(readFileSync(join(process.cwd(), 'data', 'labs.json'), 'utf8'));
const lab = labs.find((l: { id: string }) => l.id === labId);
if (!lab) {
  console.error(`no lab "${labId}" in data/labs.json`);
  process.exit(1);
}
const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];

const store = new Store(join(process.cwd(), lab.graph));
const orch = new Lab({ dry: DRY, theme, store, settings: lab.roleSettings });

(async () => {
  const rootTask = store.addTask('Top-level charge', TASK);
  await orch.spawn(0, rootTask);
  console.log(`run complete: ${store.nodes.length} nodes, ${store.edges.length} edges`);
})().catch((e) => {
  console.error('run failed:', e);
  process.exit(1);
});
