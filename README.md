# Claude Lab

A macOS desktop app that runs **Claude Code agents as a configurable hierarchy**, visualized as an interactive node graph. Think of it as a different surface for Claude Code: each node is a generic Claude Code session, rooted in a working directory, that you drive manually — but agents can delegate scoped sub-tasks to "junior" agents below them, each tuned for the job.

Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Uses your existing Claude subscription (the same first-party login Claude Code uses) — **no API key required**.

## Features

- **Agent hierarchy** — pick a theme (Research Lab / Team / Company); each lab is a 5-tier hierarchy (e.g. Principal Investigator → Laboratory Manager → Post Doc → PhD Student → Undergrad).
- **Real Claude Code per agent** — each agent is a full Claude Code session in the lab's working directory: reads your `CLAUDE.md`, your settings, project MCP servers/hooks. Streams responses token-by-token with live tool-activity, rendered Markdown, and a token counter.
- **Delegation with handoffs** — an agent writes a short, structured plan; the sub-agent confirms it and pauses for your approval before working. The parent auto-names the task and auto-tunes the sub-agent's model + effort to the work.
- **One-click deploy buttons** — after a reply, the app extracts the concrete next-steps the agent proposed and offers "Deploy a <role> to…" buttons (or "Deploy N — one per task").
- **Per-agent model + effort** — Opus 4.8 / 4.7 / 4.6, Sonnet 4.6, Haiku 4.5, Fable 5; effort low→max.
- **Rewind & branch** — edit-and-resend a message, or fork a conversation into a new sibling agent (via session forking).
- **Shared lab log** — every agent's actions and findings are recorded; agents read it (and each other's handoff verdicts) to stay in sync.
- **Stop** any run (button or Esc), drag to resize the chat panel, paste/attach images, name agents, and a per-lab "working"/"finished" indicator on the labs rail.

## Requirements

- **macOS** (Apple Silicon). The packaged build and the "Open in terminal" feature are macOS-only; the core works cross-platform in dev.
- **Node.js 20+**
- An active **Claude login** the Agent SDK can use — install and sign into [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) first. Agents run on your subscription's rate limits.

## Setup

```bash
git clone https://github.com/willkatzka/claude-lab && cd claude-lab
npm install          # also installs the ui/ workspace via postinstall
```

## Run

**Development** (hot-reloading UI + Electron):

```bash
npm run desktop:dev
```

**Production-style run** (build then launch):

```bash
npm run desktop
```

**Package a `.dmg`:**

```bash
npm run dist:mac     # unsigned build → release/ (Gatekeeper warns on open)
```

**Signed + notarized `.dmg`** (for sharing — opens with no warning). Requires a
**Developer ID Application** certificate in your keychain and notarization
credentials in the environment, then:

```bash
# App Store Connect API key (recommended)
export APPLE_API_KEY=/path/to/AuthKey_XXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# …or Apple ID:  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID

npm run dist:mac:signed     # signs, hardens, and notarizes → release/
```

## Architecture

- **`ui/`** — Vite + React + TypeScript front-end. React Flow node graph, chat panels, controls.
- **`server/bridge.mjs`** — an Express server (port 8787) that runs the Agent SDK **in-process** and exposes the lab/agent/chat API. Bundled to `dist-server/bridge.mjs` for packaging.
- **`electron/`** — Electron shell (`main.cjs` / `preload.cjs`). Starts the bridge, serves the built UI, native menu + folder picker, relocates writable data to `userData`.
- **`src/`** — shared TypeScript: the graph store, themes/roles, orchestrator.
- **`data-seed/`** — the empty lab list shipped with the app. Your live labs live in a gitignored `data/` (dev) or the app's `userData` (packaged).

## Notes

- Labs, graphs, and audit logs are stored locally and are **not** committed (`data/` is gitignored).
- Each agent runs with `bypassPermissions` so it doesn't prompt mid-run — it has full tool access in its working directory. Point a lab at a repo you trust it to act in.
