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

/** One `agent(...)` call site, statically extracted (no eval). */
export interface WorkflowAgentCall {
  /** opts.label string literal, or null when absent/non-literal. */
  label: string | null;
  /** opts.phase string literal, or null when absent/non-literal. */
  phase: string | null;
  /** Static (non-interpolated) text segments of the prompt arg, longest-first
   *  and filtered to distinctive lengths. Empty when the prompt is a bare
   *  identifier/expression (e.g. `agent(c.prompt)`) — unmatchable, so the live
   *  tier falls back to a flat (ungrouped) agent. */
  staticSegments: string[];
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
  const re = new RegExp(field + '\\s*:\\s*([\'"`])((?:\\\\.|(?!\\1).)*)\\1');
  const m = text.match(re);
  return m ? unescapeJsString(m[2]) : null;
}

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

/** Split a template-literal body (no backticks) into its static text segments,
 *  dropping each `${ ... }` interpolation. Escapes are decoded so a segment
 *  matches the expanded prompt text verbatim. */
function templateStaticSegments(body: string): string[] {
  const segs: string[] = [];
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { buf += c + (body[i + 1] ?? ''); i++; continue; }
    if (c === '$' && body[i + 1] === '{') {
      // Skip the balanced ${ ... }, treating inner strings/braces as opaque.
      const interp = extractBalanced(body, i + 1, '{', '}');
      segs.push(buf);
      buf = '';
      if (!interp) { return segs.map(unescapeJsString); } // unbalanced: stop
      i += interp.length; // advance past '${' + '...}' (i+1 is '{', +len lands after '}')
      continue;
    }
    buf += c;
  }
  segs.push(buf);
  return segs.map(unescapeJsString);
}

/** Distinctive static segments of a prompt literal, longest-first. A plain
 *  quoted string is one segment; a template literal is split on interpolations. */
function promptSegments(literal: string): string[] {
  const q = literal[0];
  const body = literal.slice(1, -1);
  const raw = q === '`' ? templateStaticSegments(body) : [unescapeJsString(body)];
  return raw
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
    let afterPrompt = i;
    const c0 = inner[i];
    if (c0 === '`' || c0 === "'" || c0 === '"') {
      const lit = extractStringLiteral(inner, i);
      if (lit) {
        staticSegments = promptSegments(lit);
        afterPrompt = i + lit.length;
      }
    }

    // Second argument = the opts object literal; pull label/phase from it only
    // (never the prompt body, which may contain the words "label:"/"phase:").
    let label: string | null = null;
    let phase: string | null = null;
    const braceIdx = inner.indexOf('{', afterPrompt);
    if (braceIdx >= 0) {
      const optsText = extractBalanced(inner, braceIdx, '{', '}');
      if (optsText) {
        label = matchStringField(optsText, 'label');
        phase = matchStringField(optsText, 'phase');
      }
    }

    calls.push({ label, phase, staticSegments });
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
