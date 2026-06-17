// Interactive delegation: append a new sub-project + child agent under an
// existing node, spawned by the bridge when the user clicks "Delegate" in a chat.
//
//   tsx src/delegate.ts --lab=<id> --parent=<nodeId> --brief="..."  [--dry]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lab } from './orchestrator.js';
import { Store } from './store.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

const arg = (p: string) => process.argv.find((a) => a.startsWith(p))?.slice(p.length);
const DRY = process.argv.includes('--dry');
const labId = arg('--lab=');
const parentId = arg('--parent=');
const brief = arg('--brief=') ?? 'Handle this sub-project.';

if (!labId || !parentId) {
  console.error('delegate.ts requires --lab=<id> and --parent=<nodeId>');
  process.exit(1);
}

const labs = JSON.parse(readFileSync(join(process.cwd(), 'data', 'labs.json'), 'utf8'));
const lab = labs.find((l: { id: string }) => l.id === labId);
if (!lab) {
  console.error(`no lab "${labId}"`);
  process.exit(1);
}
const theme = THEMES[lab.theme] ?? THEMES[DEFAULT_THEME];

const store = Store.open(join(process.cwd(), lab.graph)); // hydrate existing graph
const parent = store.nodes.find((n) => n.id === parentId);
if (!parent || parent.type !== 'agent') {
  console.error('parent must be an existing agent node');
  process.exit(1);
}
const childRank = (parent.rank ?? 0) + 1;
if (childRank >= theme.roles.length) {
  console.error('leaf agents cannot delegate further');
  process.exit(1);
}

const orch = new Lab({ dry: DRY, theme, store, settings: lab.roleSettings });

(async () => {
  const task = store.addTask(`Added · ${theme.roles[childRank]}`, brief);
  store.addEdge(parent.id, task.id, 'delegates');
  await orch.spawn(childRank, task, '', { noDelegate: true }); // one node, no cascade
  console.log(`delegated to ${theme.roles[childRank]} under ${parent.title}`);
})().catch((e) => {
  console.error('delegate failed:', e);
  process.exit(1);
});
