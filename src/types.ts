/**
 * Central type re-export. The type definitions live in domain modules —
 * sessionTypes.ts, teamTypes.ts, workflowTypes.ts, panelTypes.ts,
 * jsonlTypes.ts — split 2026-07-21 (holistic audit) once this file hit
 * ~750 lines of five unrelated domains. Existing `from './types.js'`
 * imports keep working via this shim; new code may import either the
 * domain module or this shim.
 */

export type {
  SessionStatus, DisplayStatus, StatusConfidence,
  SubagentInfo, SessionState, ToolOutcome,
  SessionSnapshot, SubagentSnapshot,
  SessionMeta, SessionMetaFile,
} from './sessionTypes.js';

export type {
  TeamAgentEntry, TeamManifest, TeamAgentSnapshot, TeamSnapshot,
} from './teamTypes.js';

export type {
  WorkflowRunStatus, WorkflowAgentStatus, WorkflowPhase,
  WorkflowAgentSnapshot, WorkflowSnapshot,
} from './workflowTypes.js';

export type {
  UsageSnapshot, WorkspaceGroup, PanelUpdate, WorktreeRow,
  WebviewMessage, WebviewCommand,
  FooterSlotSpec, UsageFooterSlot, FooterSlotPayload, SeracExports,
} from './panelTypes.js';

export type {
  JsonlRecordType, JsonlRecord, JsonlContentBlock,
} from './jsonlTypes.js';

// The Detail* view shapes and TranscriptEntry live in detailShared.ts (a
// vscode-free module compiled into both the extension and webview bundles);
// re-exported here so extension-side code keeps one central types import.
export type {
  DetailSource, DetailAgentStatus, DetailAgentView, DetailGroupView,
  DetailViewChoice, DetailModel, TranscriptEntry,
} from './detailShared.js';
