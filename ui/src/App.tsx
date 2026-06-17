import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { ChatPanel } from './components/ChatPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { NewLabModal } from './components/NewLabModal';
import { AccountPanel } from './components/AccountPanel';
import { AuditPanel } from './components/AuditPanel';
import { EmptyCanvas } from './components/EmptyCanvas';
import { GlobalSettings } from './components/GlobalSettings';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { Thinking } from './components/Thinking';
import {
  assignNode,
  delegateNode,
  deleteLab,
  deleteNode,
  getGraph,
  getLabs,
  openInTerminal,
  patchNode,
  renameLab,
  setLabCwd,
  canPickFolder,
  pickFolder,
} from './api';
import { agentDisplay, type Graph, type GraphNode, type LabInfo } from './types';

export default function App() {
  const [labs, setLabs] = useState<LabInfo[]>([]);
  const [labId, setLabId] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [pi, setPi] = useState<GraphNode | null>(null);
  const [subs, setSubs] = useState<GraphNode[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newLabOpen, setNewLabOpen] = useState(false);
  const [deployMode, setDeployMode] = useState<'app' | 'terminal'>('app');
  const [auditLab, setAuditLab] = useState<LabInfo | null>(null);
  const [busyLabs, setBusyLabs] = useState<Record<string, boolean>>({});
  const [doneLabs, setDoneLabs] = useState<Record<string, boolean>>({}); // finished while you were elsewhere
  const [activeChatId, setActiveChatId] = useState<string | null>(null); // chat being typed in (green)
  const prevBusyRef = useRef<Record<string, boolean>>({});
  const labIdRef = useRef<string | null>(null);
  labIdRef.current = labId;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // Width of the chat panel; the canvas (flex:1) takes the rest. Drag the divider
  // to resize; persisted so it sticks across launches.
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('chatWidth'));
    return v >= 320 ? v : 400;
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(320, window.innerWidth - 420); // keep room for labs + canvas
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), max);
      setChatWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setChatWidth((w) => {
        localStorage.setItem('chatWidth', String(w));
        return w;
      });
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const refreshLabs = () => getLabs().then(setLabs);

  // Native menu (Settings… / New Lab) → DOM event from the preload bridge.
  useEffect(() => {
    const onMenu = (e: Event) => {
      const action = (e as CustomEvent).detail;
      if (action === 'settings') setGlobalSettingsOpen(true);
      else if (action === 'new-lab') setNewLabOpen(true);
    };
    window.addEventListener('lab:menu', onMenu);
    return () => window.removeEventListener('lab:menu', onMenu);
  }, []);

  // Re-fetch the selected lab's graph and prune any open chats whose node is gone.
  const refreshGraph = useCallback(() => {
    if (!labId) return;
    getGraph(labId).then((g) => {
      setGraph(g);
      setPi((p) => (p && g.nodes.some((n) => n.id === p.id) ? p : null));
      setSubs((s) => s.filter((x) => g.nodes.some((n) => n.id === x.id)));
    });
  }, [labId]);

  // Right-click a node → edit / delete.
  const onNodeContextMenu = useCallback(
    (n: GraphNode, x: number, y: number) => {
      if (!labId) return;
      const items: MenuItem[] = [
        {
          label: 'Rename…',
          onClick: () => {
            const title = window.prompt('Name', n.title);
            if (title != null) patchNode(labId, n.id, { title }).then(refreshGraph);
          },
        },
        {
          label: 'Edit brief…',
          onClick: () => {
            const description = window.prompt('Brief / description', n.description);
            if (description != null) patchNode(labId, n.id, { description }).then(refreshGraph);
          },
        },
        {
          label: n.type === 'agent' ? 'Delete agent + below' : 'Delete task + below',
          danger: true,
          onClick: () => {
            if (window.confirm(`Delete “${n.title}” and everything below it?`)) {
              deleteNode(labId, n.id).then(refreshGraph);
            }
          },
        },
      ];
      setMenu({ x, y, items });
    },
    [labId, refreshGraph],
  );

  // Right-click a lab → rename / delete.
  const onLabContextMenu = (
    lab: LabInfo,
    e: { preventDefault: () => void; clientX: number; clientY: number },
  ) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Audit & findings log',
          onClick: () => setAuditLab(lab),
        },
        {
          label: 'Rename…',
          onClick: () => {
            const name = window.prompt('Lab name', lab.name);
            if (name) renameLab(lab.id, name).then(refreshLabs);
          },
        },
        {
          label: 'Set working directory…',
          onClick: async () => {
            const cwd = canPickFolder()
              ? await pickFolder()
              : window.prompt('Absolute path to the repo / folder (blank = app default)', lab.cwd ?? '');
            if (cwd != null) {
              setLabCwd(lab.id, cwd)
                .then(refreshLabs)
                .catch((err) => window.alert(String(err instanceof Error ? err.message : err)));
            }
          },
        },
        {
          label: 'Delete lab',
          danger: true,
          onClick: async () => {
            if (!window.confirm(`Delete “${lab.name}”? Removes the lab, its graph, and its audit log.`)) return;
            await deleteLab(lab.id);
            const ls = await getLabs();
            setLabs(ls);
            if (lab.id === labId) setLabId(ls.find((l) => l.id !== lab.id)?.id ?? ls[0]?.id ?? null);
          },
        },
      ],
    });
  };

  useEffect(() => {
    getLabs().then((ls) => {
      setLabs(ls);
      if (ls[0]) setLabId(ls[0].id);
    });
  }, []);

  // Poll every lab's graph for a running agent → "working" indicator on its tab,
  // so you can see other labs are busy while you're focused elsewhere.
  useEffect(() => {
    if (!labs.length) return;
    let on = true;
    const tick = async () => {
      const entries = await Promise.all(
        labs.map(async (l) => {
          try {
            const g = await getGraph(l.id);
            return [l.id, g.nodes.some((n) => n.type === 'agent' && n.status === 'running')] as const;
          } catch {
            return [l.id, false] as const;
          }
        }),
      );
      if (!on) return;
      const next = Object.fromEntries(entries);
      // A lab that was busy and is now idle finished its work — flag it (green dot)
      // unless you're already viewing it.
      const finished = entries
        .filter(([id, busy]) => prevBusyRef.current[id] && !busy && id !== labIdRef.current)
        .map(([id]) => id);
      if (finished.length) setDoneLabs((d) => ({ ...d, ...Object.fromEntries(finished.map((id) => [id, true])) }));
      prevBusyRef.current = next;
      setBusyLabs(next);
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => {
      on = false;
      clearInterval(iv);
    };
  }, [labs]);

  // Initial load when switching labs: reset chat selection. When no lab is
  // selected (none exist / all deleted), clear the canvas so no stale graph shows.
  useEffect(() => {
    setPi(null);
    setSubs([]);
    // Opening a lab clears its "finished" dot.
    if (labId) setDoneLabs((d) => (d[labId] ? { ...d, [labId]: false } : d));
    if (!labId) {
      setGraph(null);
      return;
    }
    getGraph(labId).then(setGraph);
  }, [labId]);

  // Live status: poll the selected lab's graph; refresh nodes/edges and
  // re-resolve the open chats by id (so a building lab updates in place).
  useEffect(() => {
    if (!labId) return;
    const tick = () =>
      getGraph(labId)
        .then((g) => {
          setGraph(g);
          setPi((p) => (p ? g.nodes.find((n) => n.id === p.id) ?? p : p));
          setSubs((ss) => ss.map((s) => g.nodes.find((n) => n.id === s.id) ?? s));
        })
        .catch(() => {});
    const iv = setInterval(tick, 2000);
    return () => clearInterval(iv);
  }, [labId]);

  // The lead is the agent assigned to the root task (the task nothing delegates
  // to). Theme-agnostic — works for any hierarchy, not just the research lab.
  const leadAgentId = useMemo(() => {
    if (!graph) return null;
    const rootTask = graph.nodes.find(
      (n) => n.type === 'task' && !graph.edges.some((e) => e.to === n.id),
    );
    if (!rootTask) return null;
    return graph.edges.find((e) => e.kind === 'assigned' && e.from === rootTask.id)?.to ?? null;
  }, [graph]);

  // A sub-agent chat is titled by the project (task) node assigned to it.
  const labelFor = useCallback(
    (n: GraphNode) => {
      if (!graph) return n.title;
      const e = graph.edges.find((e) => e.kind === 'assigned' && e.to === n.id);
      const task = e && graph.nodes.find((x) => x.id === e.from);
      return task ? task.title : n.title;
    },
    [graph],
  );
  // Positional agent label ("Main Agent" / "Sub Agent 1a"), computed from the tree.
  const agentLabel = useCallback((n: GraphNode) => agentDisplay(n, graph?.nodes ?? []), [graph]);

  const onAgentClick = (n: GraphNode) => {
    // Terminal deployment mode: open the agent in a terminal instead of the
    // in-app chat (falls back to chat if the agent has no live session yet).
    if (deployMode === 'terminal' && n.sessionId && !n.sessionId.startsWith('mock-')) {
      openInTerminal(n.sessionId);
      return;
    }
    if (n.id === leadAgentId) setPi(n);
    else setSubs((s) => (s.some((x) => x.id === n.id) ? s : [...s, n]));
    setActiveChatId(n.id); // opening an agent focuses it (green)
  };

  // Hover ＋ on a node: agent → spawn a child below it; task → add a peer agent.
  const onSpawn = useCallback(
    (n: GraphNode) => {
      if (!labId) return;
      if (n.type === 'agent') delegateNode(labId, n.id, `A new sub-project delegated from the ${n.title}.`);
      else assignNode(labId, n.id);
    },
    [labId],
  );

  // Open (or re-open) an agent's session in a terminal via `claude --resume`.
  const onTerminal = useCallback((n: GraphNode) => {
    if (n.sessionId && !n.sessionId.startsWith('mock-')) openInTerminal(n.sessionId);
  }, []);

  // Inline title edit (click a task node's title).
  const onRename = useCallback(
    (id: string, title: string) => {
      if (labId) patchNode(labId, id, { title }).then(refreshGraph);
    },
    [labId, refreshGraph],
  );

  // Inline custom-name edit for an agent (the part after the role).
  const onSetName = useCallback(
    (id: string, name: string) => {
      if (labId) patchNode(labId, id, { name }).then(refreshGraph);
    },
    [labId, refreshGraph],
  );

  return (
    <div className="app">
      <aside className={`labs ${collapsed ? 'collapsed' : ''}`}>
        {collapsed ? (
          <button className="reopen" title="Show labs" onClick={() => setCollapsed(false)}>
            ▸
          </button>
        ) : (
          <>
            <div className="deploy-mode">
              <div className="deploy-label">Agent Deployment Mode</div>
              <div className="deploy-switch" role="group" aria-label="Agent Deployment Mode">
                <button
                  className={deployMode === 'app' ? 'on' : ''}
                  onClick={() => setDeployMode('app')}
                >
                  Desktop App
                </button>
                <button
                  className={deployMode === 'terminal' ? 'on' : ''}
                  onClick={() => setDeployMode('terminal')}
                >
                  Terminal
                </button>
              </div>
            </div>
            <div className="labs-head">
              <span>Labs</span>
              <div className="labs-head-actions">
                <button title="Lab settings" disabled={!labId} onClick={() => setSettingsOpen(true)}>
                  ⚙
                </button>
                <button title="Collapse" onClick={() => setCollapsed(true)}>
                  ◂
                </button>
              </div>
            </div>
            <div className="labs-list">
              {labs.map((l) => (
                <button
                  key={l.id}
                  className={`lab ${l.id === labId ? 'active' : ''}`}
                  onClick={() => setLabId(l.id)}
                  onContextMenu={(e) => onLabContextMenu(l, e)}
                >
                  <span className="lab-left">
                    <span className="lab-name">{l.name}</span>
                    {doneLabs[l.id] && !busyLabs[l.id] && l.id !== labId && (
                      <span className="lab-done" title="An agent finished in this lab" />
                    )}
                  </span>
                  {busyLabs[l.id] ? (
                    <span className="lab-busy" title="An agent in this lab is working">
                      <Thinking />
                    </span>
                  ) : (
                    l.container && <span className="lab-tag">{l.container}</span>
                  )}
                </button>
              ))}
              <button className="lab new" onClick={() => setNewLabOpen(true)}>
                ＋ New Lab
              </button>
            </div>
            <AccountPanel />
          </>
        )}
      </aside>

      <main className="canvas">
        {!labId ? (
          <EmptyCanvas onNewLab={() => setNewLabOpen(true)} />
        ) : graph ? (
          <ReactFlowProvider>
            <Canvas
              graph={graph}
              onAgentClick={onAgentClick}
              onSpawn={onSpawn}
              onTerminal={onTerminal}
              onRename={onRename}
              onSetName={onSetName}
              onNodeContextMenu={onNodeContextMenu}
              activeChatId={activeChatId}
              openChatIds={[pi?.id, ...subs.map((s) => s.id)].filter((x): x is string => !!x)}
            />
          </ReactFlowProvider>
        ) : (
          <div className="loading">Loading lab…</div>
        )}
      </main>

      <div className="divider" onMouseDown={startResize} title="Drag to resize the chat panel" />

      <ChatPanel
        pi={pi}
        subs={subs}
        labId={labId}
        width={chatWidth}
        deployMode={deployMode}
        labelFor={labelFor}
        agentLabel={agentLabel}
        activeChatId={activeChatId}
        onFocusChat={setActiveChatId}
        onClose={(id) => {
          setSubs((s) => s.filter((x) => x.id !== id));
          setPi((p) => (p && p.id === id ? null : p));
          setActiveChatId((a) => (a === id ? null : a));
        }}
      />

      {settingsOpen && labId && (
        <SettingsPanel
          labId={labId}
          labName={labs.find((l) => l.id === labId)?.name ?? ''}
          onClose={() => setSettingsOpen(false)}
          onDeleted={async () => {
            setSettingsOpen(false);
            const ls = await getLabs();
            setLabs(ls);
            setLabId(ls.find((l) => l.id !== labId)?.id ?? ls[0]?.id ?? null);
          }}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {globalSettingsOpen && <GlobalSettings onClose={() => setGlobalSettingsOpen(false)} />}

      {auditLab && (
        <AuditPanel labId={auditLab.id} labName={auditLab.name} onClose={() => setAuditLab(null)} />
      )}

      {newLabOpen && (
        <NewLabModal
          onClose={() => setNewLabOpen(false)}
          onCreated={async (id) => {
            setNewLabOpen(false);
            await refreshLabs();
            setLabId(id); // select it — polling will show it build
          }}
        />
      )}
    </div>
  );
}
