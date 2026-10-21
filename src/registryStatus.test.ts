import { describe, it, expect } from 'vitest';
import type { LiveProcess } from './processRegistry.js';
import { createRegistryStatusFeed, REGISTRY_VERDICT_HOLD_MS, type StatusRegistry } from './registryStatus.js';

function proc(over: Partial<LiveProcess> = {}): LiveProcess {
  return { pid: 1, sessionId: 's1', cwd: '/w', startedAt: 1, kind: 'interactive', entrypoint: 'claude-vscode', ...over } as LiveProcess;
}

const ok = async () => 'ok' as const;

function fakeRegistry(procs: LiveProcess[] = [], clean = true) {
  const r = { procs, clean, active: true };
  const reg: StatusRegistry = {
    isActive: () => r.active,
    isScanClean: () => r.clean,
    getProcessesForSession: (id) => r.procs.filter(p => p.sessionId === id),
  };
  return { r, reg };
}

describe('registry status feed', () => {
  it('maps busy/waiting/idle and reports since from statusUpdatedAt', () => {
    const { r, reg } = fakeRegistry([proc({ status: 'busy', statusUpdatedAt: 100 })]);
    const feed = createRegistryStatusFeed(reg, () => true, Date.now, ok);
    expect(feed.verdictFor('s1')).toMatchObject({ status: 'running', raw: 'busy', since: 100 });
    r.procs = [proc({ status: 'idle', statusUpdatedAt: 200 })];
    expect(feed.verdictFor('s1')).toMatchObject({ status: 'done', raw: 'idle', since: 200 });
  });

  it('takes the worst of several processes, with waitingFor', () => {
    const { reg } = fakeRegistry([
      proc({ pid: 1, status: 'busy', statusUpdatedAt: 5 }),
      proc({ pid: 2, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 9 }),
    ]);
    const feed = createRegistryStatusFeed(reg, () => true, Date.now, ok);
    expect(feed.verdictFor('s1')).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt', since: 9 });
  });

  it('a clean scan with no live entry is null at once, never done', () => {
    const { r, reg } = fakeRegistry([proc({ status: 'busy' })]);
    const feed = createRegistryStatusFeed(reg, () => true, Date.now, ok);
    expect(feed.verdictFor('s1')).not.toBeNull();
    r.procs = [];
    expect(feed.verdictFor('s1')).toBeNull();
  });

  it('holds the last verdict through an unclean scan or a status-less newborn, then lets go', () => {
    let t = 1000;
    const { r, reg } = fakeRegistry([proc({ status: 'busy' })]);
    const feed = createRegistryStatusFeed(reg, () => true, () => t, ok);
    expect(feed.verdictFor('s1')?.status).toBe('running');
    r.clean = false;
    t += 1000;
    expect(feed.verdictFor('s1')?.status).toBe('running');
    r.clean = true;
    r.procs = [proc({ status: null })];
    t += 1000;
    expect(feed.verdictFor('s1')?.status).toBe('running');
    t += REGISTRY_VERDICT_HOLD_MS;
    expect(feed.verdictFor('s1')).toBeNull();
  });

  it('a writer that never stamps status gives no verdict', () => {
    const { reg } = fakeRegistry([proc({ status: undefined })]);
    expect(createRegistryStatusFeed(reg, () => true, Date.now, ok).verdictFor('s1')).toBeNull();
  });

  it('flag off or an inactive registry gives null', () => {
    const { r, reg } = fakeRegistry([proc({ status: 'busy' })]);
    expect(createRegistryStatusFeed(reg, () => false, Date.now, ok).verdictFor('s1')).toBeNull();
    r.active = false;
    expect(createRegistryStatusFeed(reg, () => true, Date.now, ok).verdictFor('s1')).toBeNull();
  });

  it('drops an entry whose pid now belongs to another process', async () => {
    const { reg } = fakeRegistry([proc({ status: 'busy' })]);
    let answer: (r: 'ok' | 'bad') => void = () => {};
    const verify = () => new Promise<'ok' | 'bad'>(res => { answer = res; });
    const feed = createRegistryStatusFeed(reg, () => true, Date.now, verify);
    expect(feed.verdictFor('s1')?.status).toBe('running'); // trusted while ps runs
    answer('bad');
    await Promise.resolve();
    expect(feed.verdictFor('s1')).toBeNull();
  });

  it('probeFor binds one session', () => {
    const { reg } = fakeRegistry([proc({ status: 'waiting', waitingFor: 'input needed' })]);
    const probe = createRegistryStatusFeed(reg, () => true, Date.now, ok).probeFor('s1');
    expect(probe.enabled()).toBe(true);
    expect(probe.verdict()).toMatchObject({ status: 'waiting', waitingFor: 'input needed' });
  });
});
