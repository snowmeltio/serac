import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as https from 'https';
import * as cp from 'child_process';
import type { UsageSnapshot } from './types.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { claudeStateDir, claudeKeychainService } from './paths.js';

/** Shape of the Anthropic OAuth usage API response */
interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at: string } | null;
  seven_day?: { utilization: number; resets_at: string } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
  seven_day_opus?: { utilization: number; resets_at: string } | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number;
    utilization: number | null;
  } | null;
}

/**
 * Provides usage data from two sources:
 * 1. Anthropic OAuth API — real quota percentages and reset times (server truth)
 * 2. Local JSONL parsing — per-session cost estimates (for card cost pills)
 */
export class UsageProvider {
  private snapshot: UsageSnapshot = emptySnapshot();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private onChangeCallback: (() => void) | undefined;
  private readonly projectsDir: string;
  private readonly workspaceKey: string;
  private refreshing = false;
  private disposed = false;

  // Cached OAuth token
  private oauthToken: string | null = null;
  private tokenExpiresAt = 0;

  // Last successful API response (survives transient failures / 429s)
  private lastApiData: UsageApiResponse | null = null;
  // Disk cache path for API response (survives extension reloads)
  private readonly cachePath: string;

  // API call throttle: don't call more than once per cooldown period
  private lastApiCallAttempt = 0;
  private apiCooldownMs = 0; // randomised each cycle

  constructor(workspacePath: string, opts?: { cachePath?: string }) {
    const stateDir = claudeStateDir();
    this.projectsDir = path.join(stateDir, 'projects');
    this.workspaceKey = sanitiseWorkspaceKey(workspacePath);
    this.cachePath = opts?.cachePath ?? path.join(stateDir, 'usage-cache.json');
    this.loadDiskCache();
  }

  /** Start polling for usage data */
  start(onChange: () => void): void {
    this.onChangeCallback = onChange;
    void this.refresh();
    this.schedulePoll();
  }

  /** Schedule next poll with randomised interval (4-6 minutes) */
  private schedulePoll(): void {
    if (this.disposed) { return; }
    const minMs = 4 * 60 * 1000;
    const maxMs = 6 * 60 * 1000;
    const interval = minMs + Math.random() * (maxMs - minMs);
    this.pollTimer = setTimeout(() => {
      if (this.disposed) { return; }
      void this.refresh();
      this.schedulePoll();
    }, interval);
  }

  stop(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  /** Force a refresh (called on session change events too) */
  async refresh(): Promise<void> {
    if (this.refreshing) { return; }
    this.refreshing = true;
    try {
      const freshApiData = await this.fetchUsageApi();

      // Cache successful responses; reuse last good data on failure (429, network, etc.)
      if (freshApiData) {
        this.lastApiData = freshApiData;
        await this.saveDiskCache(freshApiData);
      }
      const apiData = this.lastApiData;

      const now = Date.now();

      this.snapshot = {
        // API-sourced quota data (server truth, cached across transient failures)
        quotaPct5h: apiData?.five_hour?.utilization ?? 0,
        resetTime: apiData?.five_hour?.resets_at
          ? new Date(apiData.five_hour.resets_at).getTime() : null,
        quotaPctWeekly: apiData?.seven_day?.utilization ?? 0,
        weeklyResetTime: apiData?.seven_day?.resets_at
          ? new Date(apiData.seven_day.resets_at).getTime() : null,
        quotaPctWeeklySonnet: apiData?.seven_day_sonnet?.utilization ?? null,
        weeklyResetTimeSonnet: apiData?.seven_day_sonnet?.resets_at
          ? new Date(apiData.seven_day_sonnet.resets_at).getTime() : null,
        extraUsageEnabled: apiData?.extra_usage?.is_enabled ?? false,
        extraUsageCredits: apiData?.extra_usage?.used_credits ?? null,
        apiConnected: apiData !== null,
        platformSupported: process.platform === 'darwin',

        currentWorkspaceKey: this.workspaceKey,

        loaded: true,
        lastPoll: now,
      };

      this.onChangeCallback?.();
    } catch {
      // Silently fail — usage is nice-to-have, not critical
    } finally {
      this.refreshing = false;
    }
  }

  // ── Disk cache (survives extension reloads) ─────────────────────────

  private loadDiskCache(): void {
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const cached = JSON.parse(raw);
      // Only use cache if less than 15 minutes old
      if (cached._ts && Date.now() - cached._ts < 15 * 60 * 1000) {
        const ts = cached._ts;
        delete cached._ts;
        this.lastApiData = cached as UsageApiResponse;
        // Seed throttle from disk — prevents cross-window duplicate calls
        this.lastApiCallAttempt = ts;
        this.rollCooldown();
      }
    } catch {
      // No cache or invalid — start fresh
    }
  }

  /** Re-read disk cache if another window wrote fresher data [MW1] */
  private reloadDiskCacheIfFresh(): void {
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const cached = JSON.parse(raw);
      // Only adopt if the cached timestamp is newer than our last API call
      if (cached._ts && cached._ts > this.lastApiCallAttempt) {
        const ts = cached._ts;
        delete cached._ts;
        this.lastApiData = cached as UsageApiResponse;
        this.lastApiCallAttempt = ts;
        this.rollCooldown();
      }
    } catch {
      // Cache unreadable — proceed with API call
    }
  }

  private async saveDiskCache(data: UsageApiResponse): Promise<void> {
    try {
      const tmpPath = this.cachePath + `.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify({ ...data, _ts: Date.now() }), 'utf-8');
      await fs.promises.rename(tmpPath, this.cachePath);
    } catch {
      // Non-critical
    }
  }

  // ── OAuth API ──────────────────────────────────────────────────────

  /** Randomise the next cooldown: 600-900 seconds */
  private rollCooldown(): void {
    this.apiCooldownMs = (600 + Math.random() * 300) * 1000;
  }

  private async fetchUsageApi(): Promise<UsageApiResponse | null> {
    // Cross-window coordination: check if another window wrote fresh cache [MW1]
    this.reloadDiskCacheIfFresh();

    // Throttle: skip if we're still within the cooldown window
    const elapsed = Date.now() - this.lastApiCallAttempt;
    if (this.lastApiCallAttempt > 0 && elapsed < this.apiCooldownMs) {
      return null; // caller falls back to lastApiData
    }

    const token = await this.getOAuthToken();
    if (!token) { return null; }

    return new Promise((resolve) => {

      // Record attempt time and roll next cooldown BEFORE the call
      this.lastApiCallAttempt = Date.now();
      this.rollCooldown();

      // Guard against double-resolution from concurrent events (timeout + end, destroy + end)
      let resolved = false;
      const settle = (value: UsageApiResponse | null) => {
        if (resolved) { return; }
        resolved = true;
        resolve(value);
      };

      const req = https.get('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain
          settle(null);
          return;
        }
        let data = '';
        const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB cap [F11]
        res.on('data', (chunk: string) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_BYTES) {
            res.destroy();
            settle(null);
          }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Basic shape check: must be a plain object
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              settle(parsed as UsageApiResponse);
            } else {
              settle(null);
            }
          } catch { settle(null); }
        });
      });

      req.on('error', () => settle(null));
      req.setTimeout(5000, () => { req.destroy(); settle(null); });
    });
  }

  private async getOAuthToken(): Promise<string | null> {
    // Return cached token if not expired (with 60s buffer)
    if (this.oauthToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.oauthToken;
    }

    // Try macOS Keychain (only available on darwin) — async to avoid blocking extension host
    if (process.platform === 'darwin') {
      try {
        const username = os.userInfo().username;
        const raw = await new Promise<string>((resolve, reject) => {
          cp.execFile(
            'security',
            ['find-generic-password', '-a', username, '-s', claudeKeychainService(), '-w'],
            { encoding: 'utf-8', timeout: 3000 },
            (err, stdout) => { err ? reject(err) : resolve(stdout.trim()); },
          );
        });
        const creds = JSON.parse(raw);
        if (creds.claudeAiOauth?.accessToken) {
          this.oauthToken = creds.claudeAiOauth.accessToken;
          this.tokenExpiresAt = creds.claudeAiOauth.expiresAt || 0;
          return this.oauthToken;
        }
      } catch {
        // Keychain unavailable — no fallback
      }
    }

    // Plaintext credential fallback removed [H5] — Keychain-only on macOS
    return null;
  }

}

function emptySnapshot(): UsageSnapshot {
  return {
    quotaPct5h: 0,
    resetTime: null,
    quotaPctWeekly: 0,
    weeklyResetTime: null,
    quotaPctWeeklySonnet: null,
    weeklyResetTimeSonnet: null,
    extraUsageEnabled: false,
    extraUsageCredits: null,
    apiConnected: false,
    platformSupported: process.platform === 'darwin',
    currentWorkspaceKey: '',
    loaded: false,
    lastPoll: 0,
  };
}
