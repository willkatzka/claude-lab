// Mirrors the orchestrator's store schema (the graph contract).
export type NodeType = 'agent' | 'task' | 'directory' | 'log';
export type Status = 'running' | 'waiting' | 'done';
export type EdgeKind = 'delegates' | 'assigned' | 'access';

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  status: Status;
  sessionId: string | null;
  role?: string;
  rank?: number; // 0 = lead
  result?: string;
  model?: string; // per-agent model override (else the role default)
  effort?: string; // per-agent effort override (else the role default)
  permission?: string; // per-agent permission override (else the role default)
  name?: string; // custom label shown after the role ("Role: Name")
  path?: string; // directory: folder path; log: markdown file path
}
export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}
export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}
export interface LabInfo {
  id: string;
  name: string;
  container?: string; // e.g. "Lab" | "Team" | "Company"
  cwd?: string; // working directory (repo/folder) agents run in
}
export interface ChatMsg {
  role: string;
  text: string;
  uuid?: string; // transcript messages carry a UUID — used to rewind/branch here
}

// ---- Per-role presets ----
export type Model = 'opus' | 'sonnet' | 'haiku' | 'fable';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionLevel =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto';

export interface RoleSetting {
  model: Model;
  effort: Effort;
  permissionMode: PermissionLevel;
}

export interface LabSettings {
  theme: string;
  themeName: string;
  container: string;
  roles: string[];
  roleSettings: RoleSetting[];
}

export interface AppSettings {
  defaultTheme: string;
  defaultPresets: RoleSetting[];
}

export interface ThemeInfo {
  id: string;
  name: string;
  container: string;
  roles: string[];
}

export interface Account {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
}
export interface RateWindow {
  utilization: number | null;
  resets_at: string | null;
}
export interface Usage {
  session: { total_cost_usd: number; model_usage: Record<string, unknown> };
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: { five_hour?: RateWindow | null; seven_day?: RateWindow | null } | null;
}
export interface AccountData {
  account: Account;
  usage: Usage | null;
}

export interface AuditEvent {
  ts: string;
  type: 'spawn' | 'delegate' | 'finding' | 'tool' | 'message' | 'terminal' | string;
  agentId?: string;
  role?: string;
  rank?: number;
  model?: string;
  effort?: string;
  permission?: string;
  taskId?: string;
  task?: string;
  brief?: string;
  text?: string;
  reply?: string;
  tool?: string;
  target?: string;
}

export const MODEL_OPTIONS: Model[] = ['opus', 'sonnet', 'haiku', 'fable'];
export const EFFORT_OPTIONS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Exact, version-pinned models selectable per-agent in the chat header. Stored
// verbatim on the node (node.model) and passed straight to the Agent SDK.
export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];
const ALIAS_TO_MODEL: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};
// Map a stored alias ('opus') or exact id to the canonical version-pinned id.
export const normalizeModel = (m?: string): string =>
  (m && (ALIAS_TO_MODEL[m] ?? m)) || 'claude-opus-4-8';
export const modelLabel = (id: string): string =>
  MODEL_CHOICES.find((c) => c.id === id)?.label ?? id;

// Positional, theme-independent agent labels: the lead is "Main Agent"; others
// are "Sub Agent <rank>" with a sibling letter (a, b, …) when more than one agent
// shares that rank (so a lone sub is "Sub Agent 1"; two under main → "1a"/"1b").
type AgentLike = { id: string; type?: string; title: string; name?: string; rank?: number };
const idNum = (id: string) => parseInt(String(id).split('-')[1] ?? '0', 10) || 0;
export const agentRole = (n: AgentLike, agents: AgentLike[] = []): string => {
  const rank = n.rank ?? 0;
  if (rank === 0) return 'Main Agent';
  const peers = agents
    .filter((a) => (a.type ?? 'agent') === 'agent' && (a.rank ?? 0) === rank)
    .sort((a, b) => idNum(a.id) - idNum(b.id));
  const idx = peers.findIndex((a) => a.id === n.id);
  const letter = peers.length > 1 && idx >= 0 ? String.fromCharCode(97 + idx) : '';
  return `Sub Agent ${rank}${letter}`;
};
// The full display label: positional role + the custom name when set.
export const agentDisplay = (n: AgentLike, agents: AgentLike[] = []): string => {
  const role = agentRole(n, agents);
  return n.name ? `${role}: ${n.name}` : role;
};
export const PERMISSION_OPTIONS: PermissionLevel[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
];
