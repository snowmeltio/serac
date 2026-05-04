import { describe, it, expect, vi } from 'vitest';
import { FooterSlotRegistry } from './footerSlots.js';

describe('FooterSlotRegistry.register', () => {
  it('returns a handle with update/dispose and reflects the spec in payloads', () => {
    const reg = new FooterSlotRegistry();
    const handle = reg.register('snowmelt-account', { label: 'm@murray.sh' });
    expect(typeof handle.update).toBe('function');
    expect(typeof handle.dispose).toBe('function');
    const payloads = reg.getPayloads();
    expect(payloads).toEqual([{ slotId: 'snowmelt-account', label: 'm@murray.sh', hasCommand: false }]);
  });

  it('surfaces icon, status, command flag, and tooltip in the payload', () => {
    const reg = new FooterSlotRegistry();
    reg.register('s1', {
      label: 'murray@snowmelt.io',
      icon: '❄️',
      status: 'warn',
      command: 'snowmelt.openSwitcher',
      tooltip: 'Click to switch account',
    });
    expect(reg.getPayloads()[0]).toEqual({
      slotId: 's1',
      label: 'murray@snowmelt.io',
      icon: '❄️',
      status: 'warn',
      hasCommand: true,
      tooltip: 'Click to switch account',
    });
  });

  it('rejects malformed slot ids', () => {
    const reg = new FooterSlotRegistry();
    expect(() => reg.register('1starts-with-digit', { label: 'x' })).toThrow();
    expect(() => reg.register('has spaces', { label: 'x' })).toThrow();
    expect(() => reg.register('', { label: 'x' })).toThrow();
    expect(() => reg.register('a'.repeat(65), { label: 'x' })).toThrow();
  });

  it('rejects duplicate slot ids', () => {
    const reg = new FooterSlotRegistry();
    reg.register('s1', { label: 'first' });
    expect(() => reg.register('s1', { label: 'second' })).toThrow(/already registered/);
  });

  it('rejects empty/missing label', () => {
    const reg = new FooterSlotRegistry();
    expect(() => reg.register('s1', { label: '' })).toThrow();
    expect(() => reg.register('s1', {} as never)).toThrow();
  });

  it('rejects icon longer than 4 codepoints', () => {
    const reg = new FooterSlotRegistry();
    expect(() => reg.register('s1', { label: 'x', icon: 'abcde' })).toThrow();
    // Multi-codepoint emoji ZWJ sequence within budget should pass
    expect(() => reg.register('s2', { label: 'x', icon: '👨‍💻' })).not.toThrow();
  });

  it('rejects status values outside the enum', () => {
    const reg = new FooterSlotRegistry();
    expect(() => reg.register('s1', { label: 'x', status: 'broken' as never })).toThrow();
  });

  it('truncates label past 80 chars', () => {
    const reg = new FooterSlotRegistry();
    reg.register('s1', { label: 'a'.repeat(120) });
    expect(reg.getPayloads()[0].label.length).toBe(80);
  });

  it('fires onChange when a slot is registered', () => {
    const reg = new FooterSlotRegistry();
    const cb = vi.fn();
    reg.setOnChange(cb);
    reg.register('s1', { label: 'x' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('swallows exceptions thrown by the onChange callback', () => {
    const reg = new FooterSlotRegistry();
    reg.setOnChange(() => { throw new Error('boom'); });
    expect(() => reg.register('s1', { label: 'x' })).not.toThrow();
    expect(reg.size()).toBe(1);
  });
});

describe('FooterSlotRegistry.update via handle', () => {
  it('replaces the spec and re-fires onChange', () => {
    const reg = new FooterSlotRegistry();
    const cb = vi.fn();
    reg.setOnChange(cb);
    const h = reg.register('s1', { label: 'before' });
    cb.mockClear();
    h.update({ label: 'after', status: 'ok' });
    expect(reg.getPayloads()[0]).toMatchObject({ label: 'after', status: 'ok' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is a no-op after dispose', () => {
    const reg = new FooterSlotRegistry();
    const h = reg.register('s1', { label: 'x' });
    h.dispose();
    h.update({ label: 'changed' });
    expect(reg.getPayloads()).toEqual([]);
  });

  it('validates the new spec and throws for bad input', () => {
    const reg = new FooterSlotRegistry();
    const h = reg.register('s1', { label: 'ok' });
    expect(() => h.update({ label: '' })).toThrow();
  });
});

describe('FooterSlotRegistry.dispose via handle', () => {
  it('removes the slot and fires onChange', () => {
    const reg = new FooterSlotRegistry();
    const cb = vi.fn();
    reg.setOnChange(cb);
    const h = reg.register('s1', { label: 'x' });
    cb.mockClear();
    h.dispose();
    expect(reg.size()).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is idempotent', () => {
    const reg = new FooterSlotRegistry();
    const h = reg.register('s1', { label: 'x' });
    h.dispose();
    expect(() => h.dispose()).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  it('allows re-registering the same slot id after dispose', () => {
    const reg = new FooterSlotRegistry();
    const h1 = reg.register('s1', { label: 'first' });
    h1.dispose();
    expect(() => reg.register('s1', { label: 'second' })).not.toThrow();
    expect(reg.getPayloads()[0].label).toBe('second');
  });
});

describe('FooterSlotRegistry.getCommand', () => {
  it('returns the command id when set', () => {
    const reg = new FooterSlotRegistry();
    reg.register('s1', { label: 'x', command: 'snowmelt.foo' });
    expect(reg.getCommand('s1')).toBe('snowmelt.foo');
  });

  it('returns null when the slot has no command', () => {
    const reg = new FooterSlotRegistry();
    reg.register('s1', { label: 'x' });
    expect(reg.getCommand('s1')).toBeNull();
  });

  it('returns null for unknown slot ids', () => {
    const reg = new FooterSlotRegistry();
    expect(reg.getCommand('missing')).toBeNull();
  });
});

describe('FooterSlotRegistry order', () => {
  it('preserves registration order in getPayloads', () => {
    const reg = new FooterSlotRegistry();
    reg.register('zeta', { label: 'z' });
    reg.register('alpha', { label: 'a' });
    reg.register('mu', { label: 'm' });
    expect(reg.getPayloads().map(p => p.slotId)).toEqual(['zeta', 'alpha', 'mu']);
  });
});
