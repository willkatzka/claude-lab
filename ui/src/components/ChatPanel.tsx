import { Fragment, useEffect, useRef, useState } from 'react';
import {
  branchNode,
  decidePermission,
  delegateNode,
  getMessages,
  pathForFile,
  getSettings,
  openInTerminal,
  patchNode,
  rewindNode,
  stopAgent,
  streamNodeMessage,
  suggestDelegations,
} from '../api';
import { EFFORT_OPTIONS, MODEL_CHOICES, modelLabel, normalizeModel, PERMISSION_OPTIONS } from '../types';
import type { ChatMsg, GraphNode, RoleSetting } from '../types';
import { Markdown } from './Markdown';
import { Thinking } from './Thinking';

const LEAF_RANK = 4; // themes have 5 tiers (0..4)

// A live streaming segment: streamed prose, a tool-activity line, or a pending
// permission prompt (Allow / Always allow / Deny) the agent is waiting on.
type Seg =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; verb: string; detail: string; full: string }
  | { kind: 'perm'; id: string; verb: string; detail: string; full: string; decided?: 'allow' | 'allow_always' | 'deny' };

// Deploy-suggestion results are cached per (session, reply text) so re-opening an
// agent never re-runs the (token-costing) extraction; dismissed replies stay closed.
type Suggest = { childRole: string; tasks: string[] };
const suggestCache = new Map<string, Suggest | null>();
const suggestDismissed = new Set<string>();
const suggestKey = (sessionId: string | null | undefined, text: string) => `${sessionId ?? ''}|${text}`;

function ChatBlock({
  node,
  labId,
  roleSettings,
  agentLabel,
}: {
  node: GraphNode;
  labId: string | null;
  roleSettings: RoleSetting[] | null;
  agentLabel: (n: GraphNode) => string;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState<{ url: string; mediaType: string; data: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [delBrief, setDelBrief] = useState('');
  const [delNote, setDelNote] = useState('');
  const [copied, setCopied] = useState(-1);
  const [busy, setBusy] = useState(false); // a rewind/branch is in flight
  const [actNote, setActNote] = useState('');
  const [segs, setSegs] = useState<Seg[] | null>(null); // live stream (text + tool activity), or null
  const [tokens, setTokens] = useState(0); // running output-token count for the live turn
  const [clock, setClock] = useState(0); // ticks every 1s while streaming (live elapsed)
  const startRef = useRef(0); // turn start (ms)
  const beatRef = useRef(0); // last activity/heartbeat (ms) — staleness detector
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const suggestKeyRef = useRef(''); // cache key of the reply the current suggestions came from

  const isMock = !!node.sessionId?.startsWith('mock-');
  const hasSession = !!node.sessionId && !isMock; // a real, resumable session exists
  const canChat = node.type === 'agent' && !isMock; // idle or live agents can chat
  const canDelegate = node.type === 'agent' && node.rank != null && node.rank < LEAF_RANK;
  const agentName = agentLabel(node); // positional label + custom name
  // Busy if THIS client is streaming OR the agent is running server-side (a turn
  // in flight, even one we didn't start). Blocks a second overlapping turn — the
  // cause of the "hung" behavior — and keeps the input disabled while it works.
  const running = sending || node.status === 'running';

  // The model + effort this agent runs on: its own override, else the role default.
  const roleSetting = roleSettings?.[node.rank ?? 0];
  const [model, setModel] = useState(normalizeModel(node.model || roleSetting?.model));
  const [effort, setEffort] = useState(node.effort || roleSetting?.effort || 'high');
  const [permission, setPermission] = useState(node.permission || roleSetting?.permissionMode || 'bypassPermissions');
  const [expanded, setExpanded] = useState<Set<number>>(new Set()); // expanded tool rows
  useEffect(() => {
    setModel(normalizeModel(node.model || roleSetting?.model));
    setEffort(node.effort || roleSetting?.effort || 'high');
    setPermission(node.permission || roleSetting?.permissionMode || 'bypassPermissions');
  }, [node.model, node.effort, node.permission, roleSetting?.model, roleSetting?.effort, roleSetting?.permissionMode]);
  const changeModel = (m: string) => {
    setModel(m);
    if (labId) patchNode(labId, node.id, { model: m });
  };
  const changeEffort = (e: string) => {
    setEffort(e);
    if (labId) patchNode(labId, node.id, { effort: e });
  };
  const changePermission = (p: string) => {
    setPermission(p);
    if (labId) patchNode(labId, node.id, { permission: p });
  };
  const toggleExpand = (i: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const copyMsg = (i: number, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1200);
  };

  // Attach an image file (from paste or the picker) as a base64 data URL.
  const addImage = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const data = url.split(',')[1] || '';
      if (data) setAttach((a) => [...a, { url, mediaType: file.type, data }]);
    };
    reader.readAsDataURL(file);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith('image/'));
    if (imgs.length) {
      e.preventDefault();
      imgs.forEach((it) => {
        const f = it.getAsFile();
        if (f) addImage(f);
      });
    }
  };

  // Drag & drop files into the chat: images attach as image blocks; other files
  // are referenced by absolute path (Electron exposes file.path) so the agent
  // can read them from disk.
  const [dragOver, setDragOver] = useState(false);
  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canChat || running) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    const paths: string[] = [];
    files.forEach((f) => {
      if (f.type.startsWith('image/')) addImage(f);
      else {
        const p = pathForFile(f);
        if (p) paths.push(p);
      }
    });
    if (paths.length) setDraft((d) => (d.trim() ? d.replace(/\s*$/, '') + '\n' : '') + paths.join('\n') + '\n');
  };
  const onDragOverFiles = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault();
      if (!dragOver) setDragOver(true);
    }
  };

  // Rewind = edit & resend (on YOUR messages): drop this message and everything
  // after it, and put its text back in the input so you can edit and re-send.
  const rewindTo = async (i: number) => {
    if (!labId || busy) return;
    const text = msgs[i].text;
    const keepUpTo = msgs[i - 1]?.uuid ?? ''; // history before this turn ('' => blank)
    setBusy(true);
    try {
      await rewindNode(labId, node.id, keepUpTo);
      setMsgs((m) => m.slice(0, i)); // truncate to before the edited message
      setDraft(text); // back into the type bar for editing
      setActNote('Rewound — edit and press Enter to re-send.');
    } catch (e) {
      setActNote('⚠ Rewind failed: ' + String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setActNote(''), 5000);
    }
  };

  // Branch = re-ask in a new agent (on YOUR messages): fork the history before
  // this turn into a new sibling agent and re-ask this message there.
  const branchFrom = async (i: number) => {
    if (!labId || busy) return;
    const text = msgs[i].text;
    const keepUpTo = msgs[i - 1]?.uuid ?? '';
    setBusy(true);
    try {
      await branchNode(labId, node.id, keepUpTo, text);
      setActNote('Branched — a new agent is re-answering this below in the graph.');
    } catch (e) {
      setActNote('⚠ Branch failed: ' + String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setActNote(''), 6000);
    }
  };

  // Turn an agent's reply into deployable follow-up tasks. Cached per reply, so
  // re-opening an agent shows the stored result instead of re-running extraction.
  const fetchSuggest = async (text: string) => {
    if (!labId || !canDelegate || !text) {
      setSuggest(null);
      return;
    }
    const key = suggestKey(node.sessionId, text);
    suggestKeyRef.current = key;
    if (suggestDismissed.has(key)) {
      setSuggest(null);
      return;
    }
    if (suggestCache.has(key)) {
      setSuggest(suggestCache.get(key) ?? null);
      return;
    }
    try {
      const r = await suggestDelegations(labId, node.id, text);
      const val: Suggest | null = r.childRole && r.suggestions.length ? { childRole: r.childRole, tasks: r.suggestions } : null;
      suggestCache.set(key, val);
      setSuggest(val);
    } catch {
      /* ignore */
    }
  };

  // On open, only RESTORE a cached/previously-shown suggestion for this reply —
  // never re-run extraction. New suggestions come solely from a completed turn
  // (send → fetchSuggest), so they never pop up spontaneously on a dormant chat.
  const restoreSuggest = (text: string) => {
    if (!canDelegate || !text) {
      setSuggest(null);
      return;
    }
    const key = suggestKey(node.sessionId, text);
    suggestKeyRef.current = key;
    setSuggest(suggestDismissed.has(key) ? null : suggestCache.get(key) ?? null);
  };

  // Dismiss the deploy panel for the current reply (stays closed on re-open).
  const dismissSuggest = () => {
    if (suggestKeyRef.current) suggestDismissed.add(suggestKeyRef.current);
    setSuggest(null);
  };

  // Load the transcript for a real session; mock demo nodes show brief→result;
  // idle agents (no session yet) start as a blank chat.
  useEffect(() => {
    let on = true;
    setSuggest(null);
    (async () => {
      let m: ChatMsg[] = [];
      if (hasSession) {
        try {
          m = await getMessages(node.sessionId!);
        } catch {
          /* ignore */
        }
      } else if (isMock) {
        m = [
          { role: 'user', text: node.description },
          ...(node.result ? [{ role: 'assistant', text: node.result }] : []),
        ];
      }
      if (!on) return;
      setMsgs(m);
      // Only restore a cached suggestion on open — never extract here. New ones
      // come only from a completed send, so they don't appear on dormant chats.
      const last = m[m.length - 1];
      if (last && last.role === 'assistant') restoreSuggest(last.text);
    })();
    return () => {
      on = false;
    };
    // Reload when the session swaps too (a rewind forks onto a new session id).
  }, [node.id, node.sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, sending, segs]);

  // Tick a 1s clock while a turn is streaming so the elapsed timer + staleness
  // dot update live (no tokens — pure local timer).
  const streaming = segs !== null;
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  // Esc stops a running turn (the input is disabled mid-run, so listen globally).
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // A sub-agent that has confirmed a handoff plan and is paused for your OK.
  const awaitingApproval = hasSession && node.status === 'waiting';

  const send = async (override?: string) => {
    const text = (override ?? draft).trim();
    const imgs = override ? [] : attach;
    if ((!text && imgs.length === 0) || !canChat || !labId || running) return;
    if (!override) {
      setDraft('');
      setAttach([]);
    }
    const shownText = text + (imgs.length ? `${text ? '\n' : ''}📎 ${imgs.length} image${imgs.length > 1 ? 's' : ''}` : '');
    setMsgs((m) => [...m, { role: 'user', text: shownText }]);
    setSending(true);
    setSegs([]); // empty → shows the thinking flask until the first token/tool
    setTokens(0);
    setExpanded(new Set());
    setSuggest(null); // stale once a new turn starts
    startRef.current = Date.now();
    beatRef.current = Date.now();
    setClock(Date.now());
    const beat = () => { beatRef.current = Date.now(); };
    const acc: Seg[] = [];
    // Append a text delta to the trailing text segment (or start one).
    const pushText = (t: string) => {
      const last = acc[acc.length - 1];
      if (last && last.kind === 'text') last.text += t;
      else acc.push({ kind: 'text', text: t });
      setSegs([...acc]);
    };
    try {
      await streamNodeMessage(labId, node.id, text, {
        onDelta: (t) => { beat(); pushText(t); },
        onTool: (t) => {
          beat();
          acc.push({ kind: 'tool', verb: t.verb, detail: t.detail, full: t.full });
          setSegs([...acc]);
        },
        onPermission: (p) => {
          beat();
          acc.push({ kind: 'perm', id: p.id, verb: p.verb, detail: p.detail, full: p.full });
          setSegs([...acc]);
        },
        onUsage: (out) => { beat(); setTokens(out); },
        onPing: beat,
        onDone: (d) => d.output && setTokens(d.output),
        onError: (e) => pushText('\n\n⚠ ' + e),
      }, imgs.map((a) => ({ mediaType: a.mediaType, data: a.data })));
      // Commit only the prose to the persisted transcript (tool lines are live-only).
      const finalText = acc
        .filter((s): s is Extract<Seg, { kind: 'text' }> => s.kind === 'text')
        .map((s) => s.text)
        .join('')
        .trim();
      setMsgs((m) => [...m, { role: 'assistant', text: finalText || '(no reply)' }]);
      fetchSuggest(finalText);
    } catch (e) {
      // A fetch TypeError means the local agent server was unreachable (e.g. it
      // restarted) — your message wasn't sent; say so plainly and keep the draft.
      const msg =
        e instanceof TypeError
          ? '⚠ Lost connection to the local agent server (it may have restarted). Your message wasn’t sent — try again.'
          : '⚠ ' + String(e);
      setMsgs((m) => [...m, { role: 'assistant', text: msg }]);
      if (!override) {
        setDraft(text);
        setAttach(imgs);
      }
    } finally {
      setSegs(null);
      setSending(false);
    }
  };

  // Stop the running turn — aborts the agent server-side; the stream ends with a
  // `done` (partial reply kept). Bound to the Stop button and the Escape key.
  const stop = () => {
    if (labId && running) stopAgent(labId, node.id).catch(() => {});
  };

  // Answer a pending tool-permission prompt. Mutates the seg in place (so the
  // running stream's setSegs([...acc]) keeps the decision) and unblocks the agent.
  const decide = (id: string, decision: 'allow' | 'allow_always' | 'deny') => {
    decidePermission(id, decision).catch(() => {});
    setSegs((cur) => {
      if (!cur) return cur;
      for (const s of cur) if (s.kind === 'perm' && s.id === id) s.decided = decision;
      return [...cur];
    });
  };

  const delegate = async () => {
    const b = delBrief.trim();
    if (!b || !labId) return;
    await delegateNode(labId, node.id, b);
    setDelBrief('');
    setDelOpen(false);
    setDelNote('Deploying… the agent will appear below in the graph.');
    setTimeout(() => setDelNote(''), 6000);
  };

  // Deploy one sub-agent for a suggested task (the handoff protocol tunes + plans it).
  const deployTask = async (task: string) => {
    if (!labId) return;
    await delegateNode(labId, node.id, task);
    setSuggest((s) => {
      const next = s ? { ...s, tasks: s.tasks.filter((t) => t !== task) } : s;
      suggestCache.set(suggestKeyRef.current, next && next.tasks.length ? next : null);
      return next;
    });
    setDelNote(`Deploying ${suggest?.childRole ?? 'agent'} → ${task}`);
    setTimeout(() => setDelNote(''), 6000);
  };
  // Deploy one sub-agent per remaining suggested task at once.
  const deployAll = async () => {
    if (!labId || !suggest) return;
    const tasks = suggest.tasks;
    setSuggest(null);
    suggestCache.set(suggestKeyRef.current, null);
    setDelNote(`Deploying ${tasks.length} ${suggest.childRole}s — one per task…`);
    for (const t of tasks) await delegateNode(labId, node.id, t);
    setTimeout(() => setDelNote(''), 7000);
  };

  return (
    <>
      <div className="chat-msgs" ref={scrollRef}>
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-head">
              <span className="msg-role">{m.role === 'assistant' ? agentName : m.role === 'user' ? 'You' : m.role}</span>
              <div className="msg-tools">
                <button className="msg-copy" title="Copy message" onClick={() => copyMsg(i, m.text)}>
                  {copied === i ? '✓ copied' : '⧉ copy'}
                </button>
                {hasSession && m.uuid && m.role === 'user' && (
                  <>
                    <button
                      className="msg-copy"
                      title="Rewind to here — edit and re-send this message (drops everything after)"
                      disabled={busy}
                      onClick={() => rewindTo(i)}
                    >
                      ↩ rewind
                    </button>
                    <button
                      className="msg-copy"
                      title="Branch from here — re-ask this in a new agent, keeping this one intact"
                      disabled={busy}
                      onClick={() => branchFrom(i)}
                    >
                      ⎇ branch
                    </button>
                  </>
                )}
              </div>
            </div>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <div className="msg-text">{m.text}</div>}
          </div>
        ))}
        {segs !== null && (
          <div className="msg assistant">
            <div className="msg-head">
              <span className="msg-role">{agentName}</span>
              {(() => {
                const sec = startRef.current ? Math.max(0, Math.floor((clock - startRef.current) / 1000)) : 0;
                const stale = startRef.current > 0 && clock - beatRef.current > 18000;
                const dur = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
                return (
                  <span className="msg-status" title={stale ? 'No update for a while — long-running command, or the stream stalled' : 'Working — live'}>
                    <span className={`live-dot${stale ? ' stale' : ''}`} />
                    {stale ? 'no update ' : 'working '}
                    {dur}
                    {tokens > 0 ? ` · ${tokens.toLocaleString()} tok` : ''}
                  </span>
                );
              })()}
            </div>
            {segs.length === 0 ? (
              <Thinking />
            ) : (
              segs.map((s, i) =>
                s.kind === 'tool' ? (
                  <div key={i} className={`activity${i === segs.length - 1 ? ' running' : ''}`}>
                    <button
                      className="activity-row"
                      onClick={() => s.full && toggleExpand(i)}
                      title={s.full ? 'Show details' : undefined}
                    >
                      <span className="activity-chevron">{s.full ? (expanded.has(i) ? '▾' : '▸') : '·'}</span>
                      <span className="activity-verb">{s.verb}</span>
                      {s.detail && <span className="activity-detail">{s.detail}</span>}
                      {i === segs.length - 1 && <span className="activity-running" title="still running">⟳</span>}
                    </button>
                    {expanded.has(i) && s.full && <pre className="activity-full">{s.full}</pre>}
                  </div>
                ) : s.kind === 'perm' ? (
                  <div key={i} className={`perm-prompt${s.decided ? ' decided' : ''}`}>
                    <div className="perm-ask">
                      <span className="perm-verb">{s.verb}</span>
                      {s.detail && <span className="perm-detail">{s.detail}</span>}
                    </div>
                    {s.full && s.full !== s.detail && <pre className="perm-full">{s.full}</pre>}
                    {s.decided ? (
                      <div className="perm-result">
                        {s.decided === 'deny' ? '✕ Denied' : s.decided === 'allow_always' ? '✓ Always allowed' : '✓ Allowed'}
                      </div>
                    ) : (
                      <div className="perm-actions">
                        <button className="perm-btn allow" onClick={() => decide(s.id, 'allow')}>Allow</button>
                        <button className="perm-btn always" onClick={() => decide(s.id, 'allow_always')}>Always allow</button>
                        <button className="perm-btn deny" onClick={() => decide(s.id, 'deny')}>Deny</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={i} className="stream-text">
                    <Markdown text={s.text} />
                  </div>
                ),
              )
            )}
            {/* the indicator keeps cycling at the end while more is coming */}
            {segs.length > 0 && <Thinking />}
          </div>
        )}
      </div>
      <div
        className={`chat-input${dragOver ? ' drag-over' : ''}`}
        onDrop={onDropFiles}
        onDragOver={onDragOverFiles}
        onDragLeave={() => setDragOver(false)}
      >
        {attach.length > 0 && (
          <div className="attach-row">
            {attach.map((a, i) => (
              <div className="attach-thumb" key={i}>
                <img src={a.url} alt="attachment" />
                <button title="Remove" onClick={() => setAttach((arr) => arr.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <button
            className="attach-btn"
            title="Attach an image"
            disabled={!canChat || running}
            onClick={() => fileRef.current?.click()}
          >
            ＋
          </button>
          <textarea
            value={draft}
            rows={1}
            disabled={!canChat || running}
            onChange={(e) => {
              setDraft(e.target.value);
              // auto-grow upward (caps via CSS max-height, then scrolls)
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
                (e.target as HTMLTextAreaElement).style.height = 'auto';
              }
              if (e.key === 'Escape' && running) stop();
            }}
            placeholder={
              canChat
                ? running
                  ? 'Agent is working… (Esc to stop)'
                  : 'Message this agent… (Enter to send, Shift+Enter for a new line)'
                : 'This is a demo agent'
            }
          />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            Array.from(e.target.files ?? []).forEach(addImage);
            e.target.value = '';
          }}
        />
      </div>

      {canChat && (
        <div className="chat-actions">
          <label className="model-pick" title="Model this agent runs on">
            <span>⚙</span>
            <select value={model} onChange={(e) => changeModel(e.target.value)}>
              {MODEL_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="model-pick" title="Reasoning effort">
            <span>◇</span>
            <select value={effort} onChange={(e) => changeEffort(e.target.value)}>
              {EFFORT_OPTIONS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="model-pick" title="Permission mode">
            <span>⛨</span>
            <select value={permission} onChange={(e) => changePermission(e.target.value)}>
              {PERMISSION_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {hasSession && (
            <button onClick={() => openInTerminal(node.sessionId!)} title="Open this session in a terminal">
              ⌬ Open in terminal
            </button>
          )}
          {running && (
            <button className="stop-btn" title="Stop the agent (Esc)" onClick={stop}>
              ■ Stop
            </button>
          )}
          {awaitingApproval && !running && (
            <button
              className="approve-btn"
              disabled={running}
              onClick={() => send('Approved — proceed with the plan as confirmed.')}
            >
              ✓ Approve &amp; start
            </button>
          )}
        </div>
      )}
      {awaitingApproval && (
        <div className="approve-hint">Reviewed the plan? Approve to let this agent begin — or reply with changes.</div>
      )}
      {actNote && <div className="approve-hint">{actNote}</div>}

      {canDelegate && (
        <div className="delegate">
          {/* Deploy buttons from the agent's proposed next-steps — only once the
              reply is fully done (never mid-stream, so they match the response). */}
          {!running && segs === null && suggest && suggest.tasks.length > 0 && (
            <div className="deploy-suggest">
              <div className="deploy-head">
                <span>Deploy a {suggest.childRole} to…</span>
                <button className="deploy-dismiss" title="Dismiss these suggestions" onClick={dismissSuggest}>
                  ✕
                </button>
              </div>
              {suggest.tasks.map((t) => (
                <button key={t} className="deploy-btn" title={`Deploy a ${suggest.childRole} for this`} onClick={() => deployTask(t)}>
                  <span className="deploy-plus">＋</span> {t}
                </button>
              ))}
              {suggest.tasks.length > 1 && (
                <button className="deploy-all" onClick={deployAll}>
                  ⚡ Deploy {suggest.tasks.length} {suggest.childRole}s — one per task
                </button>
              )}
            </div>
          )}
          {delOpen ? (
            <div className="delegate-box">
              <input
                value={delBrief}
                autoFocus
                onChange={(e) => setDelBrief(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') delegate();
                  if (e.key === 'Escape') setDelOpen(false);
                }}
                placeholder={`Task for a new ${suggest?.childRole ?? 'sub-agent'}…`}
              />
              <button className="primary" onClick={delegate}>
                Deploy
              </button>
              <button onClick={() => setDelOpen(false)}>✕</button>
            </div>
          ) : (
            <button className="delegate-btn" onClick={() => setDelOpen(true)}>
              ＋ Deploy an agent for a custom task
            </button>
          )}
          {delNote && <div className="delegate-note">{delNote}</div>}
        </div>
      )}
    </>
  );
}

export function ChatPanel({
  pi,
  subs,
  labId,
  width,
  deployMode,
  labelFor,
  agentLabel,
  onClose,
  activeChatId,
  onFocusChat,
}: {
  pi: GraphNode | null;
  subs: GraphNode[];
  labId: string | null;
  width: number;
  deployMode: 'app' | 'terminal';
  labelFor: (n: GraphNode) => string;
  agentLabel: (n: GraphNode) => string;
  onClose: (id: string) => void;
  activeChatId: string | null;
  onFocusChat: (id: string) => void;
}) {
  const style = { width, flex: `0 0 ${width}px` } as const;
  const [roleSettings, setRoleSettings] = useState<RoleSetting[] | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({}); // per-pane flex-grow
  useEffect(() => {
    if (!labId) {
      setRoleSettings(null);
      return;
    }
    let on = true;
    getSettings(labId)
      .then((s) => on && setRoleSettings(s.roleSettings))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [labId]);

  // Drag the divider between two stacked chats to reallocate their heights.
  const startVResize = (e: React.MouseEvent, topId: string, botId: string) => {
    e.preventDefault();
    const divider = e.currentTarget as HTMLElement;
    const topEl = divider.previousElementSibling as HTMLElement | null;
    const botEl = divider.nextElementSibling as HTMLElement | null;
    if (!topEl || !botEl) return;
    const startY = e.clientY;
    const topH0 = topEl.offsetHeight;
    const botH0 = botEl.offsetHeight;
    const sumW = (weights[topId] ?? 1) + (weights[botId] ?? 1);
    const MIN = 90;
    const onMove = (ev: MouseEvent) => {
      let dy = ev.clientY - startY;
      dy = Math.max(MIN - topH0, Math.min(dy, botH0 - MIN));
      const topH = topH0 + dy;
      const wTop = (sumW * topH) / (topH0 + botH0);
      setWeights((w) => ({ ...w, [topId]: wTop, [botId]: sumW - wTop }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  if (!pi && subs.length === 0) {
    return (
      <div className="chat empty" style={style}>
        <div className="win-drag" />
        {deployMode === 'terminal'
          ? 'Terminal deployment — click an agent to open it in your terminal (claude --resume).'
          : 'Select the lead agent (top of the hierarchy) to open the main chat.'}
      </div>
    );
  }
  // Open chats as one vertical stack (lead first), with a drag-divider between each.
  const panes = [...(pi ? [{ node: pi, main: true }] : []), ...subs.map((s) => ({ node: s, main: false }))];
  return (
    <div className="chat" style={style}>
      <div className="win-drag" />
      {panes.map((p, i) => (
        <Fragment key={p.node.id}>
          {i > 0 && (
            <div className="h-divider" title="Drag to resize" onMouseDown={(e) => startVResize(e, panes[i - 1].node.id, p.node.id)} />
          )}
          <div
            className={`${p.main ? 'chat-main' : 'sub'}${activeChatId === p.node.id ? ' active' : ''}`}
            style={{ flexGrow: weights[p.node.id] ?? 1, flexBasis: 0, minHeight: 90 }}
            onMouseDownCapture={() => onFocusChat(p.node.id)}
          >
            <div className={p.main ? 'chat-title main sub-bar' : 'chat-title sub-bar'}>
              <span>
                {p.main ? (
                  <>{agentLabel(p.node)} · main</>
                ) : (
                  <>
                    {labelFor(p.node)} <span className="sub-role">· {agentLabel(p.node)}</span>
                  </>
                )}
              </span>
              <button title="Close" onClick={() => onClose(p.node.id)}>
                ✕
              </button>
            </div>
            <ChatBlock node={p.node} labId={labId} roleSettings={roleSettings} agentLabel={agentLabel} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
