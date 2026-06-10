/**
 * Small, fail-silent reads of Claude Code environment signals under the
 * resolved state dir (claudeStateDir()):
 *
 *  - `ide/<port>.lock` — one lock per VS Code window with the Claude Code
 *    extension attached. Maps workspace folders → an IDE window, so foreign
 *    workspace rows can show "open in IDE". Locks carry an authToken —
 *    NEVER return, log, or display anything beyond pid/folders/ideName.
 *
 * The read is display-only enrichment: size-capped, schema-lenient, and a
 * missing/malformed file simply yields the empty result.
 *
 * (The `mcp-needs-auth-cache.json` reader used to live here too; the
 * needs-auth signal now surfaces via the companion's account-row dot, so
 * the reader moved to serac-snowmelt-companion.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeStateDir } from './paths.js';

const MAX_READ_BYTES = 256 * 1024;
/** Cap the lock scan defensively; a real machine has a handful of windows. */
const MAX_LOCK_FILES = 64;

function readJsonCapped(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_READ_BYTES) { return null; }
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return JSON.parse(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** Workspace folders that currently have a live VS Code window with the
 *  Claude Code extension attached, from `ide/<port>.lock` files. A lock whose
 *  pid no longer exists is skipped (stale lock). The authToken in the lock is
 *  deliberately never read into the result. */
export function readIdeOpenFolders(stateDir: string = claudeStateDir()): Set<string> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(stateDir, 'ide')).filter(f => f.endsWith('.lock')).slice(0, MAX_LOCK_FILES);
  } catch {
    return out;
  }
  for (const f of entries) {
    try {
      const parsed = readJsonCapped(path.join(stateDir, 'ide', f));
      if (!parsed || typeof parsed !== 'object') { continue; }
      const { pid, workspaceFolders } = parsed as { pid?: unknown; workspaceFolders?: unknown };
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) { continue; }
      if (!Array.isArray(workspaceFolders)) { continue; }
      try { process.kill(pid, 0); } catch { continue; } // stale lock — window gone
      for (const folder of workspaceFolders) {
        if (typeof folder === 'string' && folder.length > 0 && path.isAbsolute(folder)) {
          out.add(folder);
        }
      }
    } catch { /* unreadable lock — skip */ }
  }
  return out;
}
