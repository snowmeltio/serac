/**
 * Footer slot registry — backs the public registerUsageFooterSlot() API.
 * Pure data store + validation; the extension wires it to a redraw callback
 * and the panelProvider snapshots payloads from getPayloads() each tick.
 */
import type { FooterSlotSpec, FooterSlotPayload, UsageFooterSlot } from './types.js';

/** Slot ids must be safe for `data-` attribute round-tripping and reasonable
 *  to read in logs. Vendor-prefixed kebab/snake case is the expected style. */
const SLOT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_LABEL_LEN = 80;
const MAX_ICON_CODEPOINTS = 4;
const MAX_TOOLTIP_LEN = 200;
const MAX_COMMAND_LEN = 200;
const VALID_STATUSES: ReadonlySet<FooterSlotSpec['status']> = new Set(['ok', 'warn', 'critical']);

interface SlotEntry {
  spec: FooterSlotSpec;
}

export class FooterSlotRegistry {
  private slots = new Map<string, SlotEntry>();
  private onChange: (() => void) | undefined;

  /** Wire a redraw callback — called whenever a slot is registered, updated,
   *  or disposed. The extension hooks this to its sendUpdate() debounce. */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  register(slotId: string, initial: FooterSlotSpec): UsageFooterSlot {
    if (typeof slotId !== 'string' || !SLOT_ID_RE.test(slotId)) {
      throw new Error(
        `Invalid slot id ${JSON.stringify(slotId)}. Must match ${SLOT_ID_RE.source}.`,
      );
    }
    if (this.slots.has(slotId)) {
      throw new Error(`Slot id "${slotId}" is already registered.`);
    }
    const entry: SlotEntry = { spec: validateSpec(initial) };
    this.slots.set(slotId, entry);
    this.notify();

    let disposed = false;
    return {
      update: (next: FooterSlotSpec) => {
        if (disposed) { return; }
        entry.spec = validateSpec(next);
        this.notify();
      },
      dispose: () => {
        if (disposed) { return; }
        disposed = true;
        this.slots.delete(slotId);
        this.notify();
      },
    };
  }

  /** Snapshot of payloads in registration order. Returns a fresh array each
   *  call so callers can store/serialise without aliasing. */
  getPayloads(): FooterSlotPayload[] {
    const out: FooterSlotPayload[] = [];
    for (const [slotId, entry] of this.slots) {
      const payload: FooterSlotPayload = {
        slotId,
        label: entry.spec.label,
        hasCommand: typeof entry.spec.command === 'string' && entry.spec.command.length > 0,
      };
      if (entry.spec.icon !== undefined) { payload.icon = entry.spec.icon; }
      if (entry.spec.status !== undefined) { payload.status = entry.spec.status; }
      if (entry.spec.tooltip !== undefined) { payload.tooltip = entry.spec.tooltip; }
      out.push(payload);
    }
    return out;
  }

  /** Returns the registered command id for a slot, or null if missing or
   *  the slot has no command bound. */
  getCommand(slotId: string): string | null {
    const entry = this.slots.get(slotId);
    if (!entry || typeof entry.spec.command !== 'string' || entry.spec.command.length === 0) {
      return null;
    }
    return entry.spec.command;
  }

  /** Test/diagnostic helper. Not part of the public API. */
  size(): number {
    return this.slots.size;
  }

  private notify(): void {
    if (this.onChange) {
      try {
        this.onChange();
      } catch {
        // Swallow — a faulty redraw callback must not break registration.
      }
    }
  }
}

function validateSpec(spec: unknown): FooterSlotSpec {
  if (!spec || typeof spec !== 'object') {
    throw new Error('FooterSlotSpec must be an object.');
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.label !== 'string' || s.label.length === 0) {
    throw new Error('FooterSlotSpec.label must be a non-empty string.');
  }
  const out: FooterSlotSpec = {
    label: s.label.length > MAX_LABEL_LEN ? s.label.slice(0, MAX_LABEL_LEN) : s.label,
  };
  if (s.icon !== undefined) {
    if (typeof s.icon !== 'string') {
      throw new Error('FooterSlotSpec.icon must be a string.');
    }
    const codepoints = [...s.icon];
    if (codepoints.length === 0 || codepoints.length > MAX_ICON_CODEPOINTS) {
      throw new Error(`FooterSlotSpec.icon must be 1..${MAX_ICON_CODEPOINTS} codepoints.`);
    }
    out.icon = s.icon;
  }
  if (s.status !== undefined) {
    if (!VALID_STATUSES.has(s.status as FooterSlotSpec['status'])) {
      throw new Error('FooterSlotSpec.status must be "ok", "warn", or "critical".');
    }
    out.status = s.status as FooterSlotSpec['status'];
  }
  if (s.command !== undefined) {
    if (typeof s.command !== 'string' || s.command.length === 0 || s.command.length > MAX_COMMAND_LEN) {
      throw new Error(`FooterSlotSpec.command must be a non-empty string up to ${MAX_COMMAND_LEN} chars.`);
    }
    out.command = s.command;
  }
  if (s.tooltip !== undefined) {
    if (typeof s.tooltip !== 'string') {
      throw new Error('FooterSlotSpec.tooltip must be a string.');
    }
    out.tooltip = s.tooltip.length > MAX_TOOLTIP_LEN ? s.tooltip.slice(0, MAX_TOOLTIP_LEN) : s.tooltip;
  }
  return out;
}
