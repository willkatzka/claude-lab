// Theme data is shared between the TS orchestrator and the (JS) bridge via
// themes.json, so there's a single source of truth for hierarchies.

import themesData from './themes.json' with { type: 'json' };

export interface Theme {
  id: string;
  name: string;
  container: string; // what a project/lab is called, e.g. "Team"
  noun: string; // in-prompt org noun, e.g. "baseball team"
  roles: string[]; // 5 role titles, senior → junior
}

export const THEMES: Record<string, Theme> = Object.fromEntries(
  Object.entries(themesData as Record<string, Omit<Theme, 'id'>>).map(([id, t]) => [id, { id, ...t }]),
);

export const DEFAULT_THEME = 'research';

// ---- Per-role presets (configurable per lab) ----
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

export const DEFAULT_ROLE_SETTING: RoleSetting = {
  model: 'sonnet',
  effort: 'medium',
  permissionMode: 'bypassPermissions',
};

export const MODEL_OPTIONS: Model[] = ['opus', 'sonnet', 'haiku', 'fable'];
export const EFFORT_OPTIONS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_OPTIONS: PermissionLevel[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
];
