import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from './sessionDiscovery.js';
import { isValidSessionId } from './validation.js';

/** Rescan the registry every Nth poll cycle. It has no "active" fast path — the
 *  data only matters when a consumer reads it — so a relaxed cadence is fine. */
const REGISTRY_SCAN_INTERVAL = 4;

/** One live Claude process, read from `~/.claude/sessions/<pid>.json`. */
export interface LiveProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number | null;
  kind: string | null;        // e.g. 'interactive'
  entrypoint: string | null;  // e.g. 'claude-vscode'
  version: string | null;
}

/** Is a pid alive? `kill(pid, 0)` sends no signal; it throws `ESRCH` when the
 *  process is gone and `EPERM` when it exists but we may not signal it (still
 *  alive). Any other error → treat as not-alive (conservative). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads Claude Code's live process registry at `~/.claude/sessions/<pid>.json`
 * — one file per running process, carrying `{pid, sessionId, cwd, ...}`. Serac
 * is otherwise a pure disk-tailing monitor that infers a session's state from
 * its JSONL; this registry is the one source that says a process is *actually
 * alive right now*, letting a consumer distinguish a truly-running session from
 * an orphaned one (process gone, JSONL just sitting there).
 *
 * Liveness is confirmed per-pid with `kill(pid, 0)` rather than trusting a
 * file's mere existence — a crashed/`-9`'d process can leave a stale file
 * behind. Absence of a live entry is NOT authoritative that a session is dead:
 * not every session class is guaranteed to register here, so a consumer should
 * treat a hit as a strong positive and a miss as "unknown". One residual caveat
 * on the positive side: if a process dies and the OS recycles its pid for an
 * unrelated process before its stale file is cleaned, `kill(pid, 0)` reports
 * that pid alive, so a hit is "very likely live", not a hard guarantee — a
 * consumer needing certainty can cross-check `startedAt` against the process.
 */
export class ProcessRegistry {
  private processes: LiveProcess[] = [];
  private liveSessionIds: Set<string> = new Set();
  private scanCounter = 0;
  /** Did the last scan read every present file cleanly? A scan that hit a
   *  non-ENOENT read error or unparseable content couldn't determine some
   *  present entry's liveness, so its *absence* of a session must NOT be read
   *  as death — see isScanClean(). False until the first successful scan. */
  private lastScanClean = false;

  constructor(
    private readonly sessionsDir: string,
    private readonly log: Logger,
  ) {}

  /** Throttled cadence for the poll loop (see `REGISTRY_SCAN_INTERVAL`). */
  shouldRescan(): boolean {
    this.scanCounter++;
    if (this.scanCounter >= REGISTRY_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** Read every `<pid>.json`, keep only entries whose pid is alive. */
  async scan(): Promise<void> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.sessionsDir);
    } catch {
      // No registry dir (no CC history / older client) — a clean observation of
      // "nothing live" (isActive() will be false, disabling any liveness gate).
      this.processes = [];
      this.liveSessionIds = new Set();
      this.lastScanClean = true;
      return;
    }

    const live: LiveProcess[] = [];
    const ids = new Set<string>();
    // Tracks whether we could account for every present file. A non-ENOENT read
    // error or unparseable content means we couldn't determine a PRESENT entry's
    // liveness — so this scan's "absence" is untrustworthy and must not be read
    // as a process having died (the permission-FP gate keys off isScanClean()).
    let clean = true;
    for (const file of files) {
      if (!file.endsWith('.json')) { continue; }
      let content: string;
      try {
        content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf-8');
      } catch (err) {
        // ENOENT = the file vanished mid-scan because the process exited — a
        // genuine "gone", not a degraded read. Any other code (EIO/EACCES/
        // EMFILE/EISDIR…) means we failed to read a file that is still present,
        // so we can't trust this scan's absence of its session.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { clean = false; }
        continue;
      }
      let rec: unknown;
      try {
        rec = JSON.parse(content);
      } catch {
        // Unparseable (possibly a partial write of a live session's file) —
        // present but unreadable as an entry → degraded, not absent.
        clean = false;
        continue;
      }
      const proc = parseEntry(rec);
      if (!proc) {
        // Parsed fine but not a valid registry entry (stray file / corrupt).
        // A healthy live session always writes a well-formed entry, so this is
        // not an unread-live-session — skip without degrading the scan.
        this.log.warn(`[liveness] Skipping malformed registry entry: ${file}`);
        continue;
      }
      if (!isPidAlive(proc.pid)) { continue; } // stale file, process gone
      live.push(proc);
      ids.add(proc.sessionId);
    }
    this.processes = live;
    this.liveSessionIds = ids;
    this.lastScanClean = clean;
  }

  /** All currently-live Claude processes (most recent scan). */
  getLiveProcesses(): LiveProcess[] {
    return this.processes;
  }

  /** True when the registry currently holds at least one live entry — i.e. the
   *  registry mechanism is in use on this machine/build. A consumer that treats
   *  "no live entry for session X" as evidence X is dead MUST first check this,
   *  so an absent/empty registry (older client that doesn't write it) doesn't
   *  make every session look dead. */
  isActive(): boolean {
    return this.liveSessionIds.size > 0;
  }

  /** True when the last scan read and parsed every present file (no non-ENOENT
   *  read error, no unparseable content). A consumer that treats "session X is
   *  absent" as evidence X died MUST gate on this, so a transient disk error on
   *  a *live* session's file can't be misread as the process exiting. A degraded
   *  scan yields "unknown", never "dead". */
  isScanClean(): boolean {
    return this.lastScanClean;
  }

  /** True when a live process is backing this session id. */
  isSessionLive(sessionId: string): boolean {
    return this.liveSessionIds.has(sessionId);
  }

  /** The live process backing a session, if any (first match). */
  getProcessForSession(sessionId: string): LiveProcess | null {
    return this.processes.find(p => p.sessionId === sessionId) ?? null;
  }

  /** True when any live process is rooted at this working directory. */
  isCwdLive(cwd: string): boolean {
    return this.processes.some(p => p.cwd === cwd);
  }

  dispose(): void {
    this.processes = [];
    this.liveSessionIds = new Set();
    this.lastScanClean = false;
  }
}

/** Validate + normalise one registry record. Returns null when it lacks the
 *  fields we rely on (`pid` + `sessionId` + `cwd`). Extra fields are ignored.
 *  `sessionId` runs through the path-traversal guard since it keys lookups. */
function parseEntry(rec: unknown): LiveProcess | null {
  if (!rec || typeof rec !== 'object') { return null; }
  const r = rec as Record<string, unknown>;
  const pid = r.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) { return null; }
  if (!isValidSessionId(r.sessionId)) { return null; }
  if (typeof r.cwd !== 'string' || r.cwd.length === 0) { return null; }
  return {
    pid,
    sessionId: r.sessionId,
    cwd: r.cwd,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : null,
    kind: typeof r.kind === 'string' ? r.kind : null,
    entrypoint: typeof r.entrypoint === 'string' ? r.entrypoint : null,
    version: typeof r.version === 'string' ? r.version : null,
  };
}
