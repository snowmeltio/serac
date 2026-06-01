import * as vscode from 'vscode';

/** Typed shape of the `serac.*` configuration namespace.
 *  Defaults mirror the historical hardcoded constants exactly, so existing
 *  users see no behaviour change on upgrade. Anything user-tunable goes here
 *  and is read via {@link readSettings} (never `getConfiguration` directly). */
export interface SeracSettings {
  show: {
    foreignWorkspaces: boolean;
    worktrees: boolean;
    usage: boolean;
    subagents: boolean;
    teams: boolean;
  };
  archive: {
    defaultRange: '1d' | '3d' | '7d' | '30d' | 'all';
    maxDoneShown: number;
  };
  refresh: {
    intervalSeconds: number;
  };
  discovery: {
    ageGateDays: number;
  };
  foreignWorkspaces: {
    /** Pixel cap on the foreign workspaces pane. 0 = auto (no cap). */
    maxHeightPx: number;
  };
  worktrees: {
    /** Pixel cap on the worktrees pane. 0 = auto (no cap). */
    maxHeightPx: number;
    autoCollapseAfterSeconds: number;
  };
  usage: {
    showWeekly: boolean;
    warnAtPercent: number;
    criticalAtPercent: number;
  };
  animations: {
    enabled: boolean;
  };
  cleanup: {
    confirmRequired: boolean;
  };
}

/** Defaults that match today's hardcoded values. Single source of truth for
 *  what the panel falls back to when a key is unset. Kept in sync with the
 *  `default` values declared in `package.json#contributes.configuration`. */
export const DEFAULT_SETTINGS: SeracSettings = {
  show: {
    foreignWorkspaces: true,
    worktrees: true,
    usage: true,
    subagents: true,
    teams: true,
  },
  archive: { defaultRange: '1d', maxDoneShown: 20 },
  refresh: { intervalSeconds: 5 },
  discovery: { ageGateDays: 7 },
  foreignWorkspaces: { maxHeightPx: 280 },
  worktrees: { maxHeightPx: 280, autoCollapseAfterSeconds: 20 },
  usage: { showWeekly: true, warnAtPercent: 85, criticalAtPercent: 100 },
  animations: { enabled: true },
  cleanup: { confirmRequired: true },
};

/** Read the current `serac.*` configuration into a typed snapshot.
 *  Always returns a complete object — missing keys fall back to
 *  {@link DEFAULT_SETTINGS}. Call again to pick up changes (or use
 *  {@link onSettingsChanged} to react). */
export function readSettings(): SeracSettings {
  const cfg = vscode.workspace.getConfiguration('serac');
  const d = DEFAULT_SETTINGS;
  return {
    show: {
      foreignWorkspaces: cfg.get<boolean>('show.foreignWorkspaces', d.show.foreignWorkspaces),
      worktrees: cfg.get<boolean>('show.worktrees', d.show.worktrees),
      usage: cfg.get<boolean>('show.usage', d.show.usage),
      subagents: cfg.get<boolean>('show.subagents', d.show.subagents),
      teams: cfg.get<boolean>('show.teams', d.show.teams),
    },
    archive: {
      defaultRange: cfg.get<SeracSettings['archive']['defaultRange']>('archive.defaultRange', d.archive.defaultRange),
      maxDoneShown: cfg.get<number>('archive.maxDoneShown', d.archive.maxDoneShown),
    },
    refresh: {
      intervalSeconds: cfg.get<number>('refresh.intervalSeconds', d.refresh.intervalSeconds),
    },
    discovery: {
      ageGateDays: cfg.get<number>('discovery.ageGateDays', d.discovery.ageGateDays),
    },
    foreignWorkspaces: {
      maxHeightPx: cfg.get<number>('foreignWorkspaces.maxHeightPx', d.foreignWorkspaces.maxHeightPx),
    },
    worktrees: {
      maxHeightPx: cfg.get<number>('worktrees.maxHeightPx', d.worktrees.maxHeightPx),
      autoCollapseAfterSeconds: cfg.get<number>('worktrees.autoCollapseAfterSeconds', d.worktrees.autoCollapseAfterSeconds),
    },
    usage: {
      showWeekly: cfg.get<boolean>('usage.showWeekly', d.usage.showWeekly),
      warnAtPercent: cfg.get<number>('usage.warnAtPercent', d.usage.warnAtPercent),
      criticalAtPercent: cfg.get<number>('usage.criticalAtPercent', d.usage.criticalAtPercent),
    },
    animations: {
      enabled: cfg.get<boolean>('animations.enabled', d.animations.enabled),
    },
    cleanup: {
      confirmRequired: cfg.get<boolean>('cleanup.confirmRequired', d.cleanup.confirmRequired),
    },
  };
}

/** Subscribe to `serac.*` setting changes. Callback receives a fresh snapshot
 *  whenever any key under `serac.*` changes. Returns a `Disposable` — add it
 *  to `context.subscriptions` so it's cleaned up on extension deactivate. */
export function onSettingsChanged(cb: (settings: SeracSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('serac')) {
      cb(readSettings());
    }
  });
}
