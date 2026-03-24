/**
 * Shared VS Code API mock for vitest.
 * Provides stub implementations of the vscode module APIs used by the extension.
 */
import { vi } from 'vitest';

// --- Uri ---
export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...segments].join('/'));
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
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
};

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
export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/test/workspace'), name: 'workspace', index: 0 }],
  openTextDocument: vi.fn().mockResolvedValue({ uri: Uri.file('/test/doc') }),
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
