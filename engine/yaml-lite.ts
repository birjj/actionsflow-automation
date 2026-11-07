// A deliberately small YAML subset, so the framework needs no npm dependencies.
//
// Supported:  block maps, block sequences (of scalars, maps or nested blocks),
//             single-line flow [a, b] / {a: 1}, quoted strings, comments,
//             null / true / false / numbers.
// Not supported: block scalars (| >), anchors/aliases, multi-line flow collections,
//             multi-document files. Anything unsupported throws a clear error, and
//             plain JSON is always accepted as an escape hatch.

class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
  /** 1-based source line number, for error messages */
  no: number;
}
type Parsed = [value: unknown, next: number];
interface FlowCursor {
  s: string;
  i: number;
  line: Line;
}

export function parseYaml(text: string): unknown {
  const lines = prepare(text);
  if (lines.length === 0) return undefined;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) fail(lines[next]!, 'unexpected content (bad indentation?)');
  return value;
}

/** JSON first (any valid JSON is accepted), then the YAML subset. */
export function parseStructured(text: string | null | undefined): unknown {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return parseYaml(trimmed);
  }
}

function fail(line: Line, msg: string): never {
  throw new YamlError(`YAML line ${line.no}: ${msg}`);
}

function prepare(text: string): Line[] {
  const out: Line[] = [];
  text.split('\n').forEach((raw, idx) => {
    const line = stripComment(raw.replace(/\r$/, ''));
    if (line.trim() === '') return;
    const m = /^( *)(.*)$/.exec(line) as RegExpExecArray;
    if (m[2]!.startsWith('\t') || /^\t/.test(line)) {
      throw new YamlError(`YAML line ${idx + 1}: tabs are not allowed for indentation`);
    }
    out.push({ indent: m[1]!.length, text: m[2]!.trimEnd(), no: idx + 1 });
  });
  return out;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(line[i - 1]!))) {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const isSeqLine = (t: string): boolean => t === '-' || t.startsWith('- ');

function parseBlock(lines: Line[], i: number, indent: number): Parsed {
  const line = lines[i]!;
  if (isSeqLine(line.text)) return parseSeq(lines, i, indent);
  if (splitKey(line.text)) return parseMap(lines, i, indent);
  return [parseInline(line.text, line), i + 1];
}

function parseMap(lines: Line[], i: number, indent: number): Parsed {
  const obj: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const kv = splitKey(line.text);
    if (!kv) fail(line, 'expected "key: value"');
    const [key, rest] = kv;
    if (key === '__proto__') fail(line, 'key "__proto__" is not allowed');
    if (Object.hasOwn(obj, key)) fail(line, `duplicate key "${key}"`);
    i++;
    let value: unknown;
    if (rest === '') {
      if (i < lines.length && lines[i]!.indent > indent) {
        [value, i] = parseBlock(lines, i, lines[i]!.indent);
      } else if (i < lines.length && lines[i]!.indent === indent && isSeqLine(lines[i]!.text)) {
        [value, i] = parseSeq(lines, i, indent); // "key:\n- a" (sequence at key indent)
      } else {
        value = null;
      }
    } else {
      value = parseInline(rest, line);
    }
    obj[key] = value;
  }
  if (i < lines.length && lines[i]!.indent > indent) fail(lines[i]!, 'unexpected indentation');
  return [obj, i];
}

function parseSeq(lines: Line[], i: number, indent: number): Parsed {
  const arr: unknown[] = [];
  while (i < lines.length && lines[i]!.indent === indent && isSeqLine(lines[i]!.text)) {
    const line = lines[i]!;
    const rest = line.text === '-' ? '' : line.text.slice(2).trimStart();
    let v: unknown;
    if (rest === '') {
      i++;
      if (i < lines.length && lines[i]!.indent > indent) {
        [v, i] = parseBlock(lines, i, lines[i]!.indent);
        arr.push(v);
      } else arr.push(null);
    } else if (isSeqLine(rest) || splitKey(rest)) {
      // "- key: v" / "- - x": re-indent the remainder of the line and parse it as a block.
      const offset = line.text.length - rest.length;
      lines[i] = { ...line, indent: indent + offset, text: rest };
      [v, i] = parseBlock(lines, i, indent + offset);
      arr.push(v);
    } else {
      arr.push(parseInline(rest, line));
      i++;
    }
  }
  if (i < lines.length && lines[i]!.indent > indent) fail(lines[i]!, 'unexpected indentation');
  return [arr, i];
}

/** Split "key: rest". Returns null if the text is not a mapping entry. */
function splitKey(text: string): [key: string, rest: string] | null {
  if (text[0] === '{' || text[0] === '[') return null;
  if (text[0] === '"' || text[0] === "'") {
    const q = readQuoted(text, 0);
    if (!q || text[q[1]] !== ':' || (q[1] + 1 < text.length && text[q[1] + 1] !== ' ')) return null;
    return [q[0], text.slice(q[1] + 1).trim()];
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

/** Read a quoted string starting at `start`. Returns [value, indexAfterClosingQuote] or null. */
function readQuoted(s: string, start: number): [value: string, end: number] | null {
  const q = s[start];
  if (q === '"') {
    for (let i = start + 1; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === '"') {
        try {
          return [JSON.parse(s.slice(start, i + 1)) as string, i + 1];
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  let out = '';
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { out += "'"; i++; } else return [out, i + 1];
    } else out += s[i];
  }
  return null;
}

function parsePlain(s: string): unknown {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInline(text: string, line: Line): unknown {
  const s = text.trim();
  if (s[0] === '|' || s[0] === '>') fail(line, 'block scalars (| and >) are not supported; use a quoted string');
  if (s[0] === '&' || s[0] === '*') fail(line, 'anchors and aliases are not supported');
  if (s[0] === '[' || s[0] === '{') {
    const p: FlowCursor = { s, i: 0, line };
    const v = flowValue(p);
    skipWs(p);
    if (p.i !== s.length) fail(line, 'unexpected characters after flow collection');
    return v;
  }
  if (s[0] === '"' || s[0] === "'") {
    const q = readQuoted(s, 0);
    if (!q || q[1] !== s.length) fail(line, 'bad quoted string');
    return q[0];
  }
  return parsePlain(s);
}

function skipWs(p: FlowCursor): void {
  while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i++;
}

function flowValue(p: FlowCursor): unknown {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '[') {
    p.i++;
    const arr: unknown[] = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === ']') { p.i++; return arr; }
      arr.push(flowValue(p));
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== ']') fail(p.line, 'expected "," or "]" in flow sequence');
    }
  }
  if (c === '{') {
    p.i++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === '}') { p.i++; return obj; }
      let key: string;
      if (p.s[p.i] === '"' || p.s[p.i] === "'") {
        const q = readQuoted(p.s, p.i);
        if (!q) fail(p.line, 'bad quoted key');
        [key, p.i] = q;
      } else {
        const colon = p.s.indexOf(':', p.i);
        if (colon < 0) fail(p.line, 'expected ":" in flow mapping');
        key = p.s.slice(p.i, colon).trim();
        p.i = colon;
      }
      skipWs(p);
      if (p.s[p.i] !== ':') fail(p.line, 'expected ":" in flow mapping');
      p.i++;
      if (key === '__proto__') fail(p.line, 'key "__proto__" is not allowed');
      obj[key] = flowValue(p);
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== '}') fail(p.line, 'expected "," or "}" in flow mapping');
    }
  }
  if (c === '"' || c === "'") {
    const q = readQuoted(p.s, p.i);
    if (!q) fail(p.line, 'bad quoted string');
    p.i = q[1];
    return q[0];
  }
  let j = p.i;
  while (j < p.s.length && !',]}'.includes(p.s[j]!)) j++;
  const raw = p.s.slice(p.i, j).trim();
  p.i = j;
  return parsePlain(raw);
}
