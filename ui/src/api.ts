import type {
  AccountData,
  AppSettings,
  AuditEvent,
  ChatMsg,
  Graph,
  LabInfo,
  LabSettings,
  RoleSetting,
  ThemeInfo,
} from './types';

const j = async (r: Response) => {
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
};

// Native folder picker (only available inside the Electron desktop app).
type ElectronLab = { pickFolder: () => Promise<string | null> };
const electronLab = (): ElectronLab | undefined => (window as unknown as { electronLab?: ElectronLab }).electronLab;
export const canPickFolder = (): boolean => typeof electronLab()?.pickFolder === 'function';
export const pickFolder = (): Promise<string | null> => electronLab()!.pickFolder();

export const getLabs = (): Promise<LabInfo[]> => fetch('/api/labs').then(j);
export const getGraph = (id: string): Promise<Graph> => fetch(`/api/labs/${id}/graph`).then(j);
export const getMessages = (sessionId: string): Promise<ChatMsg[]> =>
  fetch(`/api/sessions/${sessionId}/messages`).then(j);
export const sendMessage = (sessionId: string, prompt: string): Promise<{ reply: string }> =>
  fetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  }).then(j);
export const delegateNode = (
  labId: string,
  parentNodeId: string,
  brief: string,
  dry = false,
): Promise<{ started: boolean }> =>
  fetch(`/api/labs/${labId}/delegate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentNodeId, brief, dry }),
  }).then(j);
export const assignNode = (labId: string, taskNodeId: string, dry = false): Promise<{ started: boolean }> =>
  fetch(`/api/labs/${labId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskNodeId, dry }),
  }).then(j);
export const openInTerminal = (sessionId: string): Promise<{ opened: boolean }> =>
  fetch(`/api/sessions/${sessionId}/terminal`, { method: 'POST' }).then(j);

export const getThemes = (): Promise<ThemeInfo[]> => fetch('/api/themes').then(j);
export const deleteLab = (id: string): Promise<{ deleted: boolean }> =>
  fetch(`/api/labs/${id}`, { method: 'DELETE' }).then(j);
export const renameLab = (id: string, name: string): Promise<{ ok: boolean }> =>
  fetch(`/api/labs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(j);
export const patchNode = (
  labId: string,
  nodeId: string,
  fields: { title?: string; description?: string; model?: string; effort?: string; name?: string },
): Promise<{ ok: boolean }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(j);
export const deleteNode = (labId: string, nodeId: string): Promise<{ deleted: number }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}`, { method: 'DELETE' }).then(j);
export const getAudit = (id: string): Promise<AuditEvent[]> => fetch(`/api/labs/${id}/audit`).then(j);
export const getAccount = (): Promise<AccountData> => fetch('/api/account').then(j);
export const createLab = (
  name: string,
  opts: { theme?: string; cwd?: string; charge?: string } = {},
): Promise<{ id: string }> =>
  fetch('/api/labs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...opts }),
  }).then(j);
export const sendNodeMessage = (
  labId: string,
  nodeId: string,
  prompt: string,
): Promise<{ reply: string; sessionId: string }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  }).then(j);

// Rewind (edit & resend): keep history up to `uuid` (the message before the turn
// you're editing; '' resets to a blank session) so you can re-send an edited message.
export const rewindNode = (
  labId: string,
  nodeId: string,
  uuid: string,
): Promise<{ ok: boolean; sessionId: string | null }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
  }).then(j);
// Branch (re-ask in a new agent): fork history up to `uuid` into a new sibling and
// re-ask `prompt` there. The original agent is untouched.
export const branchNode = (
  labId: string,
  nodeId: string,
  uuid: string,
  prompt: string,
): Promise<{ ok: boolean; nodeId: string }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, prompt }),
  }).then(j);

export type Attachment = { mediaType: string; data: string };

// Streaming chat: reads NDJSON chunks and fires handlers as the reply forms.
export async function streamNodeMessage(
  labId: string,
  nodeId: string,
  prompt: string,
  handlers: {
    onDelta: (text: string) => void;
    onTool?: (t: { tool: string; verb: string; detail: string }) => void;
    onUsage?: (output: number) => void;
    onDone?: (d: { reply: string; sessionId: string; output: number }) => void;
    onError?: (err: string) => void;
  },
  attachments: Attachment[] = [],
): Promise<void> {
  const r = await fetch(`/api/labs/${labId}/nodes/${nodeId}/message/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, attachments }),
  });
  if (!r.ok || !r.body) throw new Error(r.statusText || 'stream failed');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: {
        type: string;
        text?: string;
        tool?: string;
        verb?: string;
        detail?: string;
        output?: number;
        reply?: string;
        sessionId?: string;
        error?: string;
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'delta') handlers.onDelta(obj.text ?? '');
      else if (obj.type === 'tool')
        handlers.onTool?.({ tool: obj.tool ?? '', verb: obj.verb ?? 'Working', detail: obj.detail ?? '' });
      else if (obj.type === 'usage') handlers.onUsage?.(obj.output ?? 0);
      else if (obj.type === 'done')
        handlers.onDone?.({ reply: obj.reply ?? '', sessionId: obj.sessionId ?? '', output: obj.output ?? 0 });
      else if (obj.type === 'error') handlers.onError?.(obj.error ?? 'error');
    }
  }
}

// Stop a running agent turn (Stop button / Escape).
export const stopAgent = (labId: string, nodeId: string): Promise<{ stopped: boolean }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}/stop`, { method: 'POST' }).then(j);

// Extract delegatable follow-up tasks from an agent's reply → deploy-buttons.
export const suggestDelegations = (
  labId: string,
  nodeId: string,
  text: string,
): Promise<{ childRole: string | null; suggestions: string[] }> =>
  fetch(`/api/labs/${labId}/nodes/${nodeId}/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then(j);

export const getAppSettings = (): Promise<AppSettings> => fetch('/api/settings').then(j);
export const saveAppSettings = (s: AppSettings): Promise<AppSettings> =>
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  }).then(j);
export const setLabTheme = (id: string, theme: string): Promise<{ ok: boolean; theme: string }> =>
  fetch(`/api/labs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  }).then(j);
export const setLabCwd = (id: string, cwd: string): Promise<{ ok: boolean }> =>
  fetch(`/api/labs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  }).then(j);
export const runLab = (id: string, task: string, dry = false): Promise<{ started: boolean }> =>
  fetch(`/api/labs/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, dry }),
  }).then(j);

export const getSettings = (id: string): Promise<LabSettings> =>
  fetch(`/api/labs/${id}/settings`).then(j);
export const saveSettings = (id: string, roleSettings: RoleSetting[]): Promise<{ ok: boolean }> =>
  fetch(`/api/labs/${id}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleSettings }),
  }).then(j);
