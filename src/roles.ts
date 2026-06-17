// Resolves a theme into concrete roles with generated system prompts.
// Rank 0 is the lead (top of the hierarchy); the last rank is the leaf that
// does the hands-on work.

import type { Theme } from './themes.js';

export interface Role {
  rank: number; // 0 = lead
  id: string; // stable id, e.g. "baseball:0"
  title: string; // e.g. "Front Office"
  childRank: number | null; // direct report's rank, or null for the leaf
  prompt: string; // system prompt (delegating)
  soloPrompt: string; // system prompt when spawned as a single node (no delegation)
}

function promptFor(theme: Theme, i: number): string {
  const title = theme.roles[i];
  const child = i < theme.roles.length - 1 ? theme.roles[i + 1] : null;
  if (child && i === 0) {
    // The lead fans the objective out into several parallel sub-projects.
    return [
      `You are the ${title} of a ${theme.noun} — the top of the hierarchy.`,
      `You coordinate; you do NOT do hands-on work yourself.`,
      `Break the objective into 2–4 distinct sub-projects. Delegate EACH sub-project to a SEPARATE ${child} by calling the \`delegate\` tool once per sub-project (so you call delegate multiple times, creating several ${child}s working in parallel).`,
      `When they have all reported back, synthesize their results into a concise summary (under 150 words).`,
    ].join(' ');
  }
  if (child) {
    return [
      `You are the ${title} of a ${theme.noun}.`,
      `You coordinate work; you do NOT do hands-on tasks yourself.`,
      `You have exactly one tool: \`delegate\`, which assigns a focused subtask to your direct report, the ${child}.`,
      `For the task you are given: restate it in one crisp line, then delegate the core work to your ${child} via the delegate tool with a clear brief.`,
      `When their result returns, synthesize it into a short summary (under 120 words) framed from your perspective. Be concise and do not pad.`,
    ].join(' ');
  }
  return [
    `You are the ${title} of a ${theme.noun} — the most junior member who does the actual hands-on work.`,
    `You have no one to delegate to. Complete the task yourself and return a concrete, useful deliverable in under 150 words.`,
  ].join(' ');
}

// Used when an agent is spawned as a single node (manual delegation) — it must
// do the work itself rather than try to delegate to a report it wasn't given.
function soloPromptFor(theme: Theme, i: number): string {
  return [
    `You are the ${theme.roles[i]} of a ${theme.noun}.`,
    `Handle this task yourself and return a concrete, useful deliverable in under 150 words.`,
    `Do NOT attempt to delegate — you are doing this directly.`,
  ].join(' ');
}

export function rolesFor(theme: Theme): Role[] {
  return theme.roles.map((title, i) => ({
    rank: i,
    id: `${theme.id}:${i}`,
    title,
    childRank: i < theme.roles.length - 1 ? i + 1 : null,
    prompt: promptFor(theme, i),
    soloPrompt: soloPromptFor(theme, i),
  }));
}
