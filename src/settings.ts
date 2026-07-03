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
    /** Inline subagent rows on session cards. Default off (Murray
     *  2026-07-03): the detail panel's subagent view (v1.16.0) is now robust
     *  enough that the inline rows are redundant noise for most users. */
    subagents: boolean;
    workflows: boolean;
    /** Same-file collision chip on cards. Default off (Murray 2026-06-10):
     *  worktree-parallel workflows never trip it; opt in when running
     *  multiple agents against one checkout. */
    fileCollisions: boolean;
  };
  archive: {
    defaultRange: '1d' | '3d' | '7d' | '30d' | 'all';
    maxDoneShown: number;
  };
  sessions: {
    /** A running/waiting session's status shows high confidence while its last
     *  activity is younger than this many seconds. */
    highConfidenceSeconds: number;
    /** ...medium confidence until older than this many seconds, then low.
     *  Should be greater than highConfidenceSeconds. */
    mediumConfidenceSeconds: number;
  };
  refresh: {
    intervalSeconds: number;
  };
  discovery: {
    /** Base staleness window (in days) for every discovery section. A section
     *  with no explicit override below inherits this value. */
    ageGateDays: number;
    /** Per-section overrides; `null` = inherit {@link ageGateDays}. Each lets
     *  one section show a longer/shorter window than the others — e.g. keep
     *  "Other workspaces" tight while letting teams linger. Resolve via
     *  {@link ageGateDaysFor}, never read directly. */
    foreignWorkspacesAgeGateDays: number | null;
    /** Visibility preset for "Other workspaces". Overrides the day-count
     *  settings unless 'inherit'. 'live-only' keys off the process registry
     *  (only sessions with a live CC process), falling back to the day-count
     *  window when the registry can't answer. Resolve via
     *  {@link foreignWindowGate}, never read directly. */
    foreignWorkspacesWindow: ForeignWindow;
    worktreesAgeGateDays: number | null;
    teamsAgeGateDays: number | null;
    workflowsAgeGateDays: number | null;
  };
  foreignWorkspaces: {
    /** Pixel cap on the foreign workspaces pane. 0 = auto (no cap). */
    maxHeightPx: number;
  };
  worktrees: {
    /** Pixel cap on the worktrees pane. 0 = auto (no cap). */
    maxHeightPx: number;
    autoCollapseAfterSeconds: number;
    /** Group foreign scratch sessions under /private/tmp (and /tmp) into a
     *  single "tmp" pseudo-repository row instead of one flat row per dir. */
    consolidateTmp: boolean;
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
  experimental: {
    /** Master gate for direct teammate messaging (write into a member's inbox).
     *  Default off — Serac's only write path into `~/.claude/`; re-checked
     *  server-side on every send, never trusted from the webview. */
    teammateMessaging: boolean;
    /** The honest sender label written as the inbox entry's `from`. Synthesized
     *  server-side (never accepted from the webview) and validated. */
    operatorName: string;
  };
  hooks: {
    /** Hook-ingress mode: patch Claude Code's settings.json so hook events
     *  stream to Serac's per-workspace socket. The snapshot here is READ-only;
     *  the enable/disable commands still write via the raw workspace-scoped
     *  `getConfiguration().update()` (this layer never writes). */
    enabled: boolean;
    /** Verbose per-event logging to the "Serac (Hooks)" output channel. */
    debug: boolean;
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
    subagents: false,
    workflows: true,
    fileCollisions: false,
  },
  archive: { defaultRange: '1d', maxDoneShown: 20 },
  sessions: { highConfidenceSeconds: 5, mediumConfidenceSeconds: 30 },
  refresh: { intervalSeconds: 5 },
  discovery: {
    ageGateDays: 7,
    foreignWorkspacesAgeGateDays: null,
    foreignWorkspacesWindow: 'inherit',
    worktreesAgeGateDays: null,
    teamsAgeGateDays: null,
    workflowsAgeGateDays: null,
  },
  foreignWorkspaces: { maxHeightPx: 280 },
  worktrees: { maxHeightPx: 280, autoCollapseAfterSeconds: 20, consolidateTmp: false },
  usage: { showWeekly: true, warnAtPercent: 85, criticalAtPercent: 100 },
  animations: { enabled: true },
  cleanup: { confirmRequired: true },
  experimental: { teammateMessaging: false, operatorName: 'operator' },
  hooks: { enabled: false, debug: false },
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
      workflows: cfg.get<boolean>('show.workflows', d.show.workflows),
      fileCollisions: cfg.get<boolean>('show.fileCollisions', d.show.fileCollisions),
    },
    archive: {
      defaultRange: cfg.get<SeracSettings['archive']['defaultRange']>('archive.defaultRange', d.archive.defaultRange),
      maxDoneShown: cfg.get<number>('archive.maxDoneShown', d.archive.maxDoneShown),
    },
    sessions: {
      highConfidenceSeconds: cfg.get<number>('sessions.highConfidenceSeconds', d.sessions.highConfidenceSeconds),
      mediumConfidenceSeconds: cfg.get<number>('sessions.mediumConfidenceSeconds', d.sessions.mediumConfidenceSeconds),
    },
    refresh: {
      intervalSeconds: cfg.get<number>('refresh.intervalSeconds', d.refresh.intervalSeconds),
    },
    discovery: {
      ageGateDays: cfg.get<number>('discovery.ageGateDays', d.discovery.ageGateDays),
      foreignWorkspacesAgeGateDays: cfg.get<number | null>('discovery.foreignWorkspacesAgeGateDays', d.discovery.foreignWorkspacesAgeGateDays),
      foreignWorkspacesWindow: validForeignWindow(cfg.get<string>('discovery.foreignWorkspacesWindow', d.discovery.foreignWorkspacesWindow)),
      worktreesAgeGateDays: cfg.get<number | null>('discovery.worktreesAgeGateDays', d.discovery.worktreesAgeGateDays),
      teamsAgeGateDays: cfg.get<number | null>('discovery.teamsAgeGateDays', d.discovery.teamsAgeGateDays),
      workflowsAgeGateDays: cfg.get<number | null>('discovery.workflowsAgeGateDays', d.discovery.workflowsAgeGateDays),
    },
    foreignWorkspaces: {
      maxHeightPx: cfg.get<number>('foreignWorkspaces.maxHeightPx', d.foreignWorkspaces.maxHeightPx),
    },
    worktrees: {
      maxHeightPx: cfg.get<number>('worktrees.maxHeightPx', d.worktrees.maxHeightPx),
      autoCollapseAfterSeconds: cfg.get<number>('worktrees.autoCollapseAfterSeconds', d.worktrees.autoCollapseAfterSeconds),
      consolidateTmp: cfg.get<boolean>('worktrees.consolidateTmp', d.worktrees.consolidateTmp),
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
    experimental: {
      teammateMessaging: cfg.get<boolean>('experimental.teammateMessaging', d.experimental.teammateMessaging),
      operatorName: cfg.get<string>('experimental.operatorName', d.experimental.operatorName),
    },
    hooks: {
      enabled: cfg.get<boolean>('hooks.enabled', d.hooks.enabled),
      debug: cfg.get<boolean>('hooks.debug', d.hooks.debug),
    },
  };
}

/** Visibility presets for the "Other workspaces" section. */
export type ForeignWindow = 'inherit' | 'live-only' | '1d' | '7d' | '30d' | 'forever';

const FOREIGN_WINDOWS: readonly ForeignWindow[] = ['inherit', 'live-only', '1d', '7d', '30d', 'forever'];

/** A discovery section with its own age-gate window. */
export type DiscoverySection = 'foreignWorkspaces' | 'worktrees' | 'teams' | 'workflows';

/** Resolve the effective staleness window (in days) for a discovery section.
 *  Returns the section's override when set to a finite positive number,
 *  otherwise the shared `serac.discovery.ageGateDays` base. This is the only
 *  supported way to read a section's gate — callers must not touch the override
 *  fields directly, so the inherit-when-unset rule lives in exactly one place.
 *  An absent (null), non-finite (e.g. `1e999` → Infinity), or non-positive
 *  override (none of which should pass the package.json `minimum`, but guard
 *  anyway) falls back to the base rather than disabling the gate. */
export function ageGateDaysFor(section: DiscoverySection, settings: SeracSettings = readSettings()): number {
  const d = settings.discovery;
  const override =
    section === 'foreignWorkspaces' ? d.foreignWorkspacesAgeGateDays
    : section === 'worktrees' ? d.worktreesAgeGateDays
    : section === 'teams' ? d.teamsAgeGateDays
    : d.workflowsAgeGateDays;
  return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : d.ageGateDays;
}

/** Day in ms, for the gate conversions below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** {@link ageGateDaysFor} in milliseconds — the one days-to-ms conversion.
 *  Discovery managers call this instead of keeping private wrappers. */
export function ageGateMsFor(section: DiscoverySection, settings: SeracSettings = readSettings()): number {
  return ageGateDaysFor(section, settings) * DAY_MS;
}

function validForeignWindow(v: string): ForeignWindow {
  return (FOREIGN_WINDOWS as readonly string[]).includes(v) ? v as ForeignWindow : 'inherit';
}

/** The resolved visibility gate for "Other workspaces": whether live-only
 *  filtering applies, and the time window in ms (Infinity = forever). When
 *  liveOnly is true the time window is the FALLBACK, used only for sessions
 *  the process registry can't answer for (degraded scan, no probe wired) —
 *  fail open to the time gate rather than blanking the section. */
export function foreignWindowGate(settings: SeracSettings = readSettings()): { liveOnly: boolean; ageGateMs: number } {
  const day = DAY_MS;
  const inherited = ageGateMsFor('foreignWorkspaces', settings);
  switch (settings.discovery.foreignWorkspacesWindow) {
    case 'live-only': return { liveOnly: true, ageGateMs: inherited };
    case '1d': return { liveOnly: false, ageGateMs: day };
    case '7d': return { liveOnly: false, ageGateMs: 7 * day };
    case '30d': return { liveOnly: false, ageGateMs: 30 * day };
    case 'forever': return { liveOnly: false, ageGateMs: Number.POSITIVE_INFINITY };
    default: return { liveOnly: false, ageGateMs: inherited };
  }
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
