// The orchestrator: spawns each agent as its own top-level Claude Code session,
// mediates delegation, and records the graph. Hierarchy comes from the active
// Theme (research lab, baseball team, company, …) — see themes.ts.

import { query, tool, createSdkMcpServer, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { THEMES, DEFAULT_THEME, DEFAULT_ROLE_SETTING, type Theme, type RoleSetting } from './themes.js';
import { rolesFor, type Role } from './roles.js';
import { Store, type GraphNode } from './store.js';

const MAX_NODES = Number(process.env.LAB_MAX_NODES ?? 40);
// How many sub-projects the lead fans out into. Deeper tiers delegate singly
// (each branch runs straight down), keeping the tree readable and bounded.
const LEAD_FANOUT = Number(process.env.LAB_FANOUT ?? 3);

function extractText(message: unknown): string {
  const blocks = (message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export interface RunResult {
  nodeId: string;
  sessionId: string | null;
  text: string;
}

export class Lab {
  store: Store;
  dry: boolean;
  theme: Theme;
  roles: Role[];
  settings: RoleSetting[]; // per-rank presets (model / effort / permission)
  onEvent?: (e: Record<string, unknown>) => void; // audit sink
  cwd?: string; // working directory agents run in (a repo/folder)
  totalCost = 0;

  constructor(opts: {
    dry?: boolean;
    store?: Store;
    theme?: Theme;
    settings?: RoleSetting[];
    onEvent?: (e: Record<string, unknown>) => void;
    cwd?: string;
  } = {}) {
    this.dry = !!opts.dry;
    this.theme = opts.theme ?? THEMES[DEFAULT_THEME];
    this.roles = rolesFor(this.theme);
    this.settings = opts.settings ?? this.roles.map(() => DEFAULT_ROLE_SETTING);
    this.store = opts.store ?? new Store();
    this.onEvent = opts.onEvent;
    this.cwd = opts.cwd;
  }

  private emit(e: Record<string, unknown>) {
    try {
      this.onEvent?.(e);
    } catch {
      /* audit must never break a run */
    }
  }

  private settingFor(rank: number): RoleSetting {
    return this.settings[rank] ?? DEFAULT_ROLE_SETTING;
  }

  // The lead fans out into several sub-projects; deeper tiers delegate singly.
  private fanout(rank: number): number {
    return rank === 0 ? LEAD_FANOUT : 1;
  }

  /** Record a delegation: parent agent --delegates--> task --assigned--> child agent. */
  private async delegateFrom(
    parentAgent: GraphNode,
    childRank: number,
    title: string,
    brief: string,
    indent: string,
  ): Promise<string> {
    const subtask = this.store.addTask(title, brief);
    this.store.addEdge(parentAgent.id, subtask.id, 'delegates');
    this.emit({ type: 'delegate', agentId: parentAgent.id, role: parentAgent.title, taskId: subtask.id, brief });
    const res = await this.spawn(childRank, subtask, indent + '  ');
    return res.text;
  }

  /** Spawn the agent at `rank` to work on `taskNode`. Returns its final text + session.
   *  opts.noDelegate spawns a single node (no auto-cascade) — used for manual
   *  delegation from the UI, where the user grows the tree one node at a time. */
  async spawn(rank: number, taskNode: GraphNode, indent = '', opts: { noDelegate?: boolean } = {}): Promise<RunResult> {
    const role = this.roles[rank];
    const agent = this.store.addAgent(role.id, role.title, taskNode.description, rank);
    this.store.addEdge(taskNode.id, agent.id, 'assigned');

    const childRank = role.childRank;
    const canDelegate = !opts.noDelegate && childRank != null && this.store.nodes.length < MAX_NODES;

    let mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
    const allowedTools: string[] = [];
    if (canDelegate) {
      const childTitle = this.roles[childRank!].title;
      const delegateTool = tool(
        'delegate',
        `Delegate a focused subtask to your direct report, the ${childTitle}. Returns their completed result as text.`,
        { title: z.string().describe('short task title'), brief: z.string().describe('what you need them to do') },
        async (args: { title: string; brief: string }) => {
          const text = await this.delegateFrom(agent, childRank!, args.title, args.brief, indent);
          return { content: [{ type: 'text' as const, text: text || '(no result)' }] };
        },
      );
      mcpServers = { lab: createSdkMcpServer({ name: 'lab', tools: [delegateTool] }) };
      allowedTools.push('mcp__lab__delegate');
    }

    const setting = this.settingFor(rank);
    this.emit({
      type: 'spawn',
      agentId: agent.id,
      role: role.title,
      rank,
      model: setting.model,
      effort: setting.effort,
      permission: setting.permissionMode,
      taskId: taskNode.id,
      task: taskNode.title,
    });
    console.log(
      `${indent}▶ ${role.title} (${agent.id}) [${setting.model}/${setting.effort}/${setting.permissionMode}] — ${taskNode.title}`,
    );
    // A non-leaf agent spawned without delegation must do the work itself.
    const systemPrompt = canDelegate ? role.prompt : role.soloPrompt;
    const { sessionId, text } = this.dry
      ? await this.mockRun(agent, role, taskNode, canDelegate, indent)
      : await this.realRun(systemPrompt, taskNode.description, mcpServers, allowedTools, canDelegate, setting, agent.id);

    agent.sessionId = sessionId;
    agent.result = text;
    agent.status = 'done';
    taskNode.status = 'done';
    this.store.persist();
    this.emit({ type: 'finding', agentId: agent.id, role: role.title, sessionId, text });
    console.log(`${indent}✓ ${role.title} done${sessionId ? `  (session ${sessionId.slice(0, 8)})` : ''}`);
    return { nodeId: agent.id, sessionId, text };
  }

  private async realRun(
    systemPrompt: string,
    prompt: string,
    mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined,
    allowedTools: string[],
    canDelegate: boolean,
    setting: RoleSetting,
    agentId: string,
  ): Promise<{ sessionId: string; text: string }> {
    let sessionId = '';
    let text = '';
    // With no tools to gate, a non-bypass permission mode can hang a headless
    // session waiting on a permission channel — coerce to bypass when tool-less.
    const permissionMode = allowedTools.length ? setting.permissionMode : 'bypassPermissions';
    // Audit: log every tool/file operation this agent performs (skip our own
    // delegate tool, which is already captured as a 'delegate' event).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preToolUse = async (input: any) => {
      const tool = input?.tool_name as string | undefined;
      const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
      if (tool && tool !== 'mcp__lab__delegate') {
        this.emit({
          type: 'tool',
          agentId,
          tool,
          target: (ti.file_path ?? ti.path ?? ti.command ?? ti.pattern ?? '') as string,
        });
      }
      return { continue: true };
    };
    const q = query({
      prompt,
      options: {
        // Run as real Claude Code (conversational tone + project settings),
        // with the role brief appended to the Claude Code system prompt.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
        mcpServers,
        allowedTools,
        model: setting.model,
        effort: setting.effort,
        permissionMode,
        maxTurns: canDelegate ? 8 : 4,
        cwd: this.cwd,
        settingSources: ['user', 'project', 'local'],
        hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      },
    });
    for await (const m of q as AsyncGenerator<SDKMessage>) {
      if (process.env.LAB_DEBUG) console.log('[realRun]', m.type, (m as { subtype?: string }).subtype ?? '');
      const sid = (m as { session_id?: string }).session_id;
      if (sid) sessionId = sid;
      if (m.type === 'assistant') text += extractText((m as { message: unknown }).message);
      if (m.type === 'result') {
        if (m.subtype === 'success') text = m.result;
        this.totalCost += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
      }
    }
    return { sessionId, text: text.trim() };
  }

  private async mockRun(
    agent: GraphNode,
    role: Role,
    taskNode: GraphNode,
    canDelegate: boolean,
    indent: string,
  ): Promise<{ sessionId: string; text: string }> {
    const parts: string[] = [];
    if (canDelegate) {
      const childTitle = this.roles[role.childRank!].title;
      const n = this.fanout(role.rank);
      for (let k = 0; k < n; k++) {
        const title = n > 1 ? `Sub-project ${k + 1} · ${childTitle}` : `Subtask for ${childTitle}`;
        const brief = `[mock] ${n > 1 ? `sub-project ${k + 1} of` : 'portion of'}: ${taskNode.description}`;
        await this.delegateFrom(agent, role.childRank!, title, brief, indent);
        parts.push(`${childTitle} #${k + 1}`);
      }
    }
    const downstream = parts.length ? ` (coordinated ${parts.length}: ${parts.join(', ')})` : '';
    return {
      sessionId: `mock-${agent.id}`,
      text: `[mock ${role.title}] handled "${taskNode.title}"${downstream}`,
    };
  }

  /** Resume any agent node by its sessionId with a follow-up prompt. */
  async resume(nodeId: string, prompt: string): Promise<string> {
    const node = this.store.get(nodeId);
    if (!node.sessionId) throw new Error(`node ${nodeId} has no session to resume`);
    node.status = 'running';
    this.store.persist();

    let text = '';
    if (this.dry) {
      text = `[mock resume of ${node.title}] re: "${prompt}"`;
    } else {
      const setting = this.settingFor(node.rank ?? 0);
      const q = query({
        prompt,
        options: {
          resume: node.sessionId,
          model: setting.model,
          effort: setting.effort,
          allowedTools: [],
          permissionMode: 'bypassPermissions', // conversation follow-up; no tools
          maxTurns: 3,
          cwd: this.cwd,
          settingSources: ['user', 'project', 'local'],
        },
      });
      for await (const m of q as AsyncGenerator<SDKMessage>) {
        if (m.type === 'assistant') text += extractText((m as { message: unknown }).message);
        if (m.type === 'result' && m.subtype === 'success') {
          text = m.result;
          this.totalCost += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
        }
      }
    }

    node.status = 'done';
    node.result = text.trim();
    this.store.persist();
    return text.trim();
  }
}
