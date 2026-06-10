// Static extractors for a workflow script. The script is NEVER eval'd:
//  - extractWorkflowMeta pulls the `export const meta = {...}` literal (name +
//    phase scaffold) so the live tier can name a run before its sidecar exists.
//  - extractAgentCalls pulls each `agent(prompt, { label, phase })` call's
//    static prompt segments + opts, so the live tier can correlate a running
//    agent's transcript (record-0 prompt) back to its phase.
// Both are bounded brace/string scans, not execution.

export interface WorkflowScriptMeta {
  name: string;
  description: string;
  phases: { title: string; detail?: string }[];
}

/** A template literal split into its ordered parts. `statics.length` is always
 *  `exprs.length + 1`, so the original expands to
 *  `statics[0] + value(exprs[0]) + statics[1] + … + statics[n]`. A plain
 *  (non-backtick) string yields one static and no exprs. Each expr is the
 *  trimmed source text inside a `${ … }` (e.g. `d.key`), never its value — the
 *  script is never eval'd. */
export interface TemplateParts {
  statics: string[];
  exprs: string[];
}

/** One `agent(...)` call site, statically extracted (no eval). */
export interface WorkflowAgentCall {
  /** opts.label string literal, or null when absent/non-literal. May still
   *  contain a raw `${…}` when the label is a template literal — callers must
   *  resolve it (see {@link recoverInterpolatedLabel}) before display. */
  label: string | null;
  /** opts.phase string literal, or null when absent/non-literal. */
  phase: string | null;
  /** Static (non-interpolated) text segments of the prompt arg, longest-first
   *  and filtered to distinctive lengths. Empty when the prompt is a bare
   *  identifier/expression (e.g. `agent(c.prompt)`) — unmatchable, so the live
   *  tier falls back to a flat (ungrouped) agent. */
  staticSegments: string[];
  /** The prompt arg as ordered template parts (statics in source order +
   *  interpolation exprs), or null when the prompt is a bare expression. Used to
   *  read each interpolation's runtime value back out of the expanded prompt. */
  promptTemplate: TemplateParts | null;
  /** The label arg as ordered template parts, present only when the label is an
   *  interpolated template (contains `${…}`); null for a plain literal/no label. */
  labelTemplate: TemplateParts | null;
}

/** A static prompt segment shorter than this is too generic to identify a call
 *  (e.g. `".\n- ` or a lone quote), so it is dropped from staticSegments. */
const MIN_DISTINCTIVE_SEGMENT = 16;

/** Decode the JS string escapes that can legitimately appear in a restricted
 *  meta literal (escaped quotes, backslash, and the common whitespace escapes),
 *  so a value authored as `'O\'Brien'` or `'line\nbreak'` surfaces correctly. */
function unescapeJsString(s: string): string {
  return s.replace(/\\(['"`\\nrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return ch; // ' " ` \
    }
  });
}

/** A single-quoted/double-quoted/backtick string field value, or null. */
function matchStringField(text: string, field: string): string | null {
  // field\s*:\s*(<quote>)(...escaped or non-quote...)<quote>
  // The body alternation must keep its branches disjoint: `\\.` consumes every
  // backslash, and the bare branch excludes both the quote and backslash. With
  // the overlapping `(?!\1).` form a run of backslashes before a missing close
  // quote backtracks exponentially (~2x per pair) and freezes the host.
  const re = new RegExp(field + '\\s*:\\s*([\'"`])((?:\\\\.|(?!\\1)[^\\\\\\n\\r])*)\\1');
  const m = text.match(re);
  return m ? unescapeJsString(m[2]) : null;
}

/** Test-only: the string-field matcher is private but its linearity on
 *  pathological input (backslash run, no closing quote) needs direct pinning —
 *  callers all pre-balance their text, so the failure path is unreachable
 *  through the public API and would silently regress without this. */
export const _matchStringFieldForTest = matchStringField;

/** Return the balanced {...} or [...] substring starting at `openIdx`, treating
 *  quoted strings as opaque so braces inside them don't unbalance the count. */
function extractBalanced(src: string, openIdx: number, open: string, close: string): string | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) { inStr = null; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === open) { depth++; }
    else if (c === close) {
      depth--;
      if (depth === 0) { return src.slice(openIdx, i + 1); }
    }
  }
  return null;
}

function extractPhases(metaText: string): { title: string; detail?: string }[] {
  const out: { title: string; detail?: string }[] = [];
  // Locate `phases: [` only OUTSIDE string literals — a literal `phases: [`
  // written inside the name/description value must not steal the match (a naive
  // /phases\s*:\s*\[/ scan would). Walk the text tracking string state.
  let arrStart = -1;
  const phaseRe = /phases\s*:\s*\[/y;
  let inStr: string | null = null;
  for (let i = 0; i < metaText.length; i++) {
    const c = metaText[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) { inStr = null; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    phaseRe.lastIndex = i;
    const m = phaseRe.exec(metaText);
    if (m && m.index === i) { arrStart = i + m[0].length - 1; break; } // at the [
  }
  if (arrStart < 0) { return out; }
  const arrText = extractBalanced(metaText, arrStart, '[', ']');
  if (!arrText) { return out; }
  // Walk top-level {...} object slices, treating quoted strings as opaque (via
  // extractBalanced) so a brace *inside* a title/detail string can't truncate
  // the object — a naive /\{[^}]*\}/ scan would stop at the first '}' char.
  inStr = null;
  for (let i = 0; i < arrText.length; i++) {
    const c = arrText[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) { inStr = null; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') {
      const obj = extractBalanced(arrText, i, '{', '}');
      if (!obj) { break; }
      const title = matchStringField(obj, 'title');
      if (title) {
        const detail = matchStringField(obj, 'detail');
        out.push(detail !== null ? { title, detail } : { title });
      }
      i += obj.length - 1; // skip past this object slice
    }
  }
  return out;
}

/**
 * Extract the workflow script's `meta` literal (name, description, phases).
 * @returns The parsed meta, or null when no usable `export const meta` is found.
 */
export function extractWorkflowMeta(source: string): WorkflowScriptMeta | null {
  const m = source.match(/export\s+const\s+meta\s*=\s*\{/);
  if (!m || m.index === undefined) { return null; }
  const braceIdx = m.index + m[0].length - 1; // at the {
  const metaText = extractBalanced(source, braceIdx, '{', '}');
  if (!metaText) { return null; }

  const name = matchStringField(metaText, 'name');
  if (!name) { return null; }

  return {
    name,
    description: matchStringField(metaText, 'description') ?? '',
    phases: extractPhases(metaText),
  };
}

/** Capture the string/template literal starting at `openIdx` (a quote char),
 *  including its delimiters, treating `\<x>` as an escaped pair. Returns null
 *  if the literal is unterminated. (For backticks this stops at the first
 *  unescaped backtick; a backtick nested inside `${ ... }` is rare in workflow
 *  prompts and is an accepted heuristic limitation.) */
function extractStringLiteral(src: string, openIdx: number): string | null {
  const q = src[openIdx];
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === q) { return src.slice(openIdx, i + 1); }
  }
  return null;
}

/** Split a template-literal body (no surrounding backticks) into ordered raw
 *  static segments and the trimmed source text of each `${ ... }` interpolation.
 *  `rawStatics.length === exprs.length + 1`. Statics are returned un-decoded so
 *  the caller can decide whether to unescape. An unbalanced `${` stops the scan
 *  (the invariant still holds: a static was pushed before the bail-out). */
function splitTemplate(body: string): { rawStatics: string[]; exprs: string[] } {
  const rawStatics: string[] = [];
  const exprs: string[] = [];
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { buf += c + (body[i + 1] ?? ''); i++; continue; }
    if (c === '$' && body[i + 1] === '{') {
      // Skip the balanced ${ ... }, treating inner strings/braces as opaque.
      const interp = extractBalanced(body, i + 1, '{', '}');
      rawStatics.push(buf);
      buf = '';
      if (!interp) { return { rawStatics, exprs }; } // unbalanced: stop
      exprs.push(interp.slice(1, -1).trim());
      i += interp.length; // advance past '${' + '...}' (i+1 is '{', +len lands after '}')
      continue;
    }
    buf += c;
  }
  rawStatics.push(buf);
  return { rawStatics, exprs };
}

/** A prompt/label string or template literal (delimiters included) as ordered
 *  {@link TemplateParts}. A plain quoted string is one static, no exprs; escapes
 *  in static text are decoded so a segment matches the expanded prompt verbatim. */
function templatePartsOf(literal: string): TemplateParts {
  const q = literal[0];
  const body = literal.slice(1, -1);
  if (q !== '`') { return { statics: [unescapeJsString(body)], exprs: [] }; }
  const { rawStatics, exprs } = splitTemplate(body);
  return { statics: rawStatics.map(unescapeJsString), exprs };
}

/** Distinctive static segments of a prompt template, longest-first, for matching
 *  a running agent's expanded prompt back to its call (interpolations differ
 *  per agent, so only the static text around them is reliable). */
function distinctiveSegments(statics: string[]): string[] {
  return statics
    .filter(s => s.trim().length >= MIN_DISTINCTIVE_SEGMENT)
    .sort((a, b) => b.length - a.length);
}

/** Mark every source index that lies inside a single/double/backtick string
 *  literal (delimiters included), using the same opaque-string walk as
 *  extractBalanced. Used to reject `agent(` matches embedded in prompt prose.
 *  Note: a `${ ... }` interpolation is treated as still-in-string here, so an
 *  agent() written inside an interpolation is (rarely) skipped — an accepted
 *  heuristic limitation, consistent with extractStringLiteral's backtick note. */
function buildStringMask(src: string): boolean[] {
  const inString = new Array<boolean>(src.length).fill(false);
  let inStr: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      inString[i] = true;
      if (c === '\\') { if (i + 1 < src.length) { inString[i + 1] = true; } i++; continue; }
      if (c === inStr) { inStr = null; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; inString[i] = true; }
  }
  return inString;
}

/**
 * Extract every `agent(prompt, { label, phase, ... })` call site statically.
 * Used by the live tier to map a running agent's record-0 prompt back to the
 * phase/label the script assigned it. Never eval'd.
 * @returns one entry per `agent(` call found (in source order).
 */
export function extractAgentCalls(source: string): WorkflowAgentCall[] {
  const calls: WorkflowAgentCall[] = [];
  const inString = buildStringMask(source);
  const re = /\bagent\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (inString[m.index]) { continue; } // phantom `agent(` inside a string/template literal
    const parenIdx = m.index + m[0].length - 1; // at '('
    const argList = extractBalanced(source, parenIdx, '(', ')');
    if (!argList) { continue; }
    const inner = argList.slice(1, -1); // drop the outer parens

    // First argument = the prompt. Either a string/template literal (matchable)
    // or a bare expression like `c.prompt` (unmatchable → no segments).
    let i = 0;
    while (i < inner.length && /\s/.test(inner[i])) { i++; }
    let staticSegments: string[] = [];
    let promptTemplate: TemplateParts | null = null;
    let afterPrompt = i;
    const c0 = inner[i];
    if (c0 === '`' || c0 === "'" || c0 === '"') {
      const lit = extractStringLiteral(inner, i);
      if (lit) {
        promptTemplate = templatePartsOf(lit);
        staticSegments = distinctiveSegments(promptTemplate.statics);
        afterPrompt = i + lit.length;
      }
    }

    // Second argument = the opts object literal; pull label/phase from it only
    // (never the prompt body, which may contain the words "label:"/"phase:").
    let label: string | null = null;
    let phase: string | null = null;
    let labelTemplate: TemplateParts | null = null;
    const braceIdx = inner.indexOf('{', afterPrompt);
    if (braceIdx >= 0) {
      const optsText = extractBalanced(inner, braceIdx, '{', '}');
      if (optsText) {
        label = matchStringField(optsText, 'label');
        phase = matchStringField(optsText, 'phase');
        // matchStringField returns the already-decoded body, so an interpolated
        // label (`audit:${d.key}`) keeps its `${…}` verbatim and can be split.
        if (label && label.includes('${')) {
          const { rawStatics, exprs } = splitTemplate(label);
          labelTemplate = { statics: rawStatics, exprs };
        }
      }
    }

    calls.push({ label, phase, staticSegments, promptTemplate, labelTemplate });
  }
  return calls;
}

/**
 * Correlate an agent's record-0 prompt back to the `agent()` call that spawned
 * it, by finding the call whose longest distinctive static segment appears
 * verbatim in the prompt. Interpolated values (`${...}`) differ per agent, so
 * we key off the static text around them.
 * @returns the matched call, or null when nothing matches (flat fallback).
 */
export function matchAgentCall(prompt: string, calls: WorkflowAgentCall[]): WorkflowAgentCall | null {
  let best: WorkflowAgentCall | null = null;
  let bestLen = 0;
  for (const call of calls) {
    for (const seg of call.staticSegments) {
      // staticSegments is longest-first, so the first hit is this call's best.
      if (prompt.includes(seg)) {
        if (seg.length > bestLen) { bestLen = seg.length; best = call; }
        break;
      }
    }
  }
  return best;
}

/** A recovered interpolation value longer than this (or spanning a newline) is
 *  almost certainly a misalignment, not a label token, so it is discarded. */
const MAX_RECOVERED_VALUE = 80;

/** Align a prompt template's static segments against the expanded prompt and
 *  read off the runtime value that sat in each interpolation slot, keyed by the
 *  interpolation's source expression (e.g. `d.key` → `privacy`). The prompt is
 *  `[wrapper] + statics[0] + v0 + statics[1] + v1 + … + statics[n]`, so each
 *  static is located in order (first one searched anywhere, to tolerate a
 *  wrapper prefix) and the text between consecutive statics is the value.
 *  Returns null if any anchor can't be found in order; oversized/multiline
 *  values are skipped (left absent) rather than recorded. */
function alignPromptValues(pt: TemplateParts, prompt: string): Map<string, string> | null {
  const { statics, exprs } = pt;
  const values = new Map<string, string>();
  let cursor = 0;
  const head = statics[0];
  if (head.length > 0) {
    const idx = prompt.indexOf(head);
    if (idx < 0) { return null; }
    cursor = idx + head.length;
  }
  for (let i = 0; i < exprs.length; i++) {
    const next = statics[i + 1];
    let valueEnd: number;
    let advance: number;
    if (next.length > 0) {
      const idx = prompt.indexOf(next, cursor);
      if (idx < 0) { return null; }
      valueEnd = idx;
      advance = idx + next.length;
    } else {
      // A trailing/empty static can't be anchored; the value runs to the end.
      valueEnd = prompt.length;
      advance = prompt.length;
    }
    const value = prompt.slice(cursor, valueEnd);
    const expr = exprs[i];
    if (expr && !values.has(expr) && value.length <= MAX_RECOVERED_VALUE && !value.includes('\n')) {
      values.set(expr, value);
    }
    cursor = advance;
  }
  return values;
}

/**
 * Rebuild an interpolated label (`audit:${d.key}`) into its real per-agent value
 * (`audit:privacy`) by recovering each interpolation's runtime value from the
 * agent's own expanded prompt — the label and prompt are authored in the same
 * scope, so an expr like `d.key` appearing in both lets us read the value out of
 * the prompt and substitute it into the label.
 * @returns the resolved label, or null when the label isn't interpolated, the
 *   prompt exposes no interpolations to read from, or any label expr can't be
 *   recovered (caller falls back). The result never contains a raw `${…}`.
 */
export function recoverInterpolatedLabel(call: WorkflowAgentCall, prompt: string): string | null {
  const lt = call.labelTemplate;
  const pt = call.promptTemplate;
  if (!lt || lt.exprs.length === 0) { return null; } // label is a plain literal
  if (!pt || pt.exprs.length === 0) { return null; } // nothing to recover from
  const values = alignPromptValues(pt, prompt);
  if (!values) { return null; }
  let out = lt.statics[0];
  for (let i = 0; i < lt.exprs.length; i++) {
    const v = values.get(lt.exprs[i]);
    if (v === undefined) { return null; } // label uses an expr the prompt never exposes
    out += v + lt.statics[i + 1];
  }
  return out.includes('${') ? null : out;
}
