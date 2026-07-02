/**
 * Shared VS Code API mock for vitest.
 * Provides stub implementations of the vscode module APIs used by the extension.
 */
import { vi } from 'vitest';

// --- Uri ---
export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  /** Non-`file` schemes (nativeDocs.ts's `serac-detail:`) have no filesystem
   *  path — `path`/`query` are the real carriers there. Defaults to `fsPath`
   *  for the `file`-scheme constructors below, matching real vscode's own
   *  near-equivalence of `.path`/`.fsPath` for that scheme. */
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  constructor(scheme: string, fsPath: string, path?: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = path ?? fsPath;
    this.query = query;
    this.fragment = fragment;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...segments].join('/'));
  }
  /** Minimal `scheme:[//authority]path[?query][#fragment]` parse — covers
   *  exactly the shapes this codebase constructs (`serac-detail:/name.ext?token`
   *  and plain `file://` paths elsewhere), not a general-purpose URI parser. */
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    const scheme = m?.[1] ?? '';
    const path = m?.[2] ?? '';
    const query = m?.[3] ?? '';
    const fragment = m?.[4] ?? '';
    return new Uri(scheme, path, path, query, fragment);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

// --- EventEmitter ---
/** Minimal stand-in for `vscode.EventEmitter`. nativeDocs.ts's provider
 *  declares (but never fires) `onDidChange` — see its docstring for why a
 *  snapshot-only virtual doc deliberately never emits — so tests mostly need
 *  this to exist and be subscribable/disposable, not to exercise firing. */
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) { this.listeners.splice(i, 1); }
      },
    };
  };
  fire(e: T): void { for (const l of this.listeners) { l(e); } }
  dispose(): void { this.listeners = []; }
}

// --- Webview ---
export function createMockWebview() {
  const messageHandlers: Array<(msg: unknown) => void> = [];
  return {
    options: {} as Record<string, unknown>,
    html: '',
    cspSource: 'https://mock.csp.source',
    postMessage: vi.fn().mockResolvedValue(true),
    onDidReceiveMessage: vi.fn((handler: (msg: unknown) => void) => {
      messageHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    asWebviewUri: vi.fn((uri: Uri) => uri),
    _fireMessage(msg: unknown) {
      for (const h of messageHandlers) { h(msg); }
    },
    _messageHandlers: messageHandlers,
  };
}

export type MockWebview = ReturnType<typeof createMockWebview>;

// --- WebviewView ---
export function createMockWebviewView(webview?: MockWebview) {
  const wv = webview ?? createMockWebview();
  return {
    webview: wv,
    badge: undefined as { value: number; tooltip: string } | undefined,
    show: vi.fn(),
  };
}

// --- Enums ---
export const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
  Active: -1,
  Beside: -2,
};

// --- WebviewPanel (editor-area panel, e.g. the workflow detail view) ---
export function createMockWebviewPanel(webview?: MockWebview) {
  const wv = webview ?? createMockWebview();
  const disposeHandlers: Array<() => void> = [];
  return {
    webview: wv,
    title: '',
    visible: true,
    active: true,
    viewColumn: ViewColumn.Beside,
    onDidDispose: vi.fn((h: () => void) => {
      disposeHandlers.push(h);
      return { dispose: vi.fn() };
    }),
    reveal: vi.fn(),
    dispose: vi.fn(() => { for (const h of disposeHandlers) { h(); } }),
    _fireDispose() { for (const h of disposeHandlers) { h(); } },
  };
}

export type MockWebviewPanel = ReturnType<typeof createMockWebviewPanel>;

// --- window ---
export const window = {
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  })),
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createWebviewPanel: vi.fn((_viewType: string, _title: string, _showOptions: unknown, _options?: unknown) => createMockWebviewPanel()),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  tabGroups: {
    all: [] as Array<{ tabs: Array<{ input: unknown; isActive: boolean }> }>,
    close: vi.fn(),
  },
};

// --- workspace ---
/** In-memory config store keyed by full dotted setting key (e.g.
 *  "serac.show.usage"). Tests use _setConfigValues to seed and
 *  _resetConfig() to clear between cases. */
const _configStore: Map<string, unknown> = new Map();
const _configChangeHandlers: Array<(e: { affectsConfiguration: (s: string) => boolean }) => void> = [];

export function _setConfigValues(values: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(values)) { _configStore.set(k, v); }
}

export function _resetConfig(): void {
  _configStore.clear();
  _configChangeHandlers.length = 0;
}

/** Fire a synthetic config-change event with the given affected section(s).
 *  `sections` are matched against the prefix queried by affectsConfiguration. */
export function _fireConfigChange(...sections: string[]): void {
  const event = {
    affectsConfiguration: (s: string) => sections.some(sec => sec === s || sec.startsWith(s + '.') || s.startsWith(sec + '.')),
  };
  for (const handler of _configChangeHandlers) { handler(event); }
}

export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/test/workspace'), name: 'workspace', index: 0 }],
  openTextDocument: vi.fn().mockResolvedValue({ uri: Uri.file('/test/doc') }),
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn((section?: string) => ({
    get<T>(key: string, defaultValue?: T): T | undefined {
      const fullKey = section ? `${section}.${key}` : key;
      return (_configStore.has(fullKey) ? _configStore.get(fullKey) : defaultValue) as T | undefined;
    },
  })),
  onDidChangeConfiguration: vi.fn((handler: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
    _configChangeHandlers.push(handler);
    return { dispose: () => {
      const i = _configChangeHandlers.indexOf(handler);
      if (i >= 0) { _configChangeHandlers.splice(i, 1); }
    }};
  }),
};

// --- commands ---
export const commands = {
  executeCommand: vi.fn().mockResolvedValue(undefined),
  registerCommand: vi.fn((_cmd: string, _cb: (...args: unknown[]) => void) => ({ dispose: vi.fn() })),
};

// --- env ---
export const env = {
  clipboard: {
    writeText: vi.fn(),
  },
  language: 'en-AU',
};

// --- ExtensionContext ---
export function createMockContext(extensionUri?: Uri): {
  extensionUri: Uri;
  subscriptions: Array<{ dispose: () => void }>;
} {
  return {
    extensionUri: extensionUri ?? Uri.file('/test/extension'),
    subscriptions: [],
  };
}
