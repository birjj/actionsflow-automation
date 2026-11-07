#!/usr/bin/env node
// Usage: node engine/cli.ts poll --key cats --fetcher adoptable-cats --input '{"source":"..."}'
// Every flag can also come from a WATCH_* env var (that's how the composite action passes
// inputs, so untrusted values are never interpolated into shell text).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluate } from './diff.ts';
import { runFetcher } from './fetcher-runner.ts';
import { readState, writeState } from './state.ts';
import { parseStructured } from './yaml-lite.ts';
import { isPlainObject } from './paths.ts';
import { appendSummary, setOutput, warning } from './github.ts';
import type { Options } from './types.ts';

const FLAGS = [
  'key', 'fetcher', 'input', 'fetchers-dir', 'state-dir', 'out-dir', 'watch-added',
  'watch-removed', 'watch-changed', 'ignore', 'first-run', 'dry-run', 'timeout-seconds',
] as const;
const INLINE_OUTPUT_LIMIT = 200_000; // bytes; step outputs are capped at 1 MB

function poll(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries(FLAGS.map((f) => [f, { type: 'string' as const }])),
  });
  /** flag, then WATCH_* env var, then default ('' counts as unset) */
  const opt = (name: string, def = ''): string => {
    const v = values[name] ?? process.env['WATCH_' + name.toUpperCase().replaceAll('-', '_')];
    return v === undefined || v === '' ? def : String(v);
  };
  const bool = (name: string, def: string): boolean => opt(name, def).trim().toLowerCase() === 'true';
  const list = (name: string): string[] => opt(name).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  const key = opt('key');
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error('key is required and must match [a-z0-9-]+');
  const fetcher = opt('fetcher');
  if (!fetcher) throw new Error('fetcher is required');

  const input = parseStructured(opt('input', '{}')) ?? {};
  if (!isPlainObject(input)) throw new Error('input must be a mapping/object');

  const stateDir = opt('state-dir', join('.watch-state', key));
  const outDir = opt('out-dir', join(process.env.RUNNER_TEMP ?? tmpdir(), 'watch', key));
  const dryRun = bool('dry-run', 'false');
  const options: Required<Options> = {
    added: bool('watch-added', 'true'),
    removed: bool('watch-removed', 'false'),
    changed: list('watch-changed'),
    ignore: list('ignore'),
    // validated at runtime by evaluate() -> normalizeOptions()
    firstRun: opt('first-run', 'baseline') as Options['firstRun'] & string,
  };

  const state = readState(stateDir);
  const { snapshot, manifest } = runFetcher({
    fetchersDir: opt('fetchers-dir', 'fetchers'),
    name: fetcher,
    input,
    outDir,
    timeoutMs: Number(opt('timeout-seconds', '300')) * 1000,
  });
  options.ignore = [...new Set([...(manifest.ignore ?? []), ...options.ignore])];

  const result = evaluate({ key, state, snapshot, options });
  const { events } = result;

  mkdirSync(outDir, { recursive: true });
  const eventsFile = join(outDir, 'events.json');
  const json = JSON.stringify(events, null, 2);
  writeFileSync(eventsFile, json);

  if (dryRun) console.log('dry-run: state not saved');
  else if (!result.persist) warning(`"${key}": first snapshot was incomplete; not saving a baseline yet`);
  else writeState(stateDir, result.state);

  const complete = result.snapshot.complete;
  if (!complete) warning(`"${key}": fetcher reported an incomplete snapshot; removals suppressed`);
  if (result.isBaseline && options.firstRun === 'baseline') {
    console.log(`baseline: recorded ${result.snapshot.items.length} item(s), no events emitted`);
  }
  console.log(`${events.length} event(s) for "${key}" (${result.snapshot.items.length} item(s) fetched)`);
  for (const e of events) console.log(`  - [${e.type}] ${e.summary}`);

  setOutput('has-events', events.length > 0);
  setOutput('count', events.length);
  setOutput('events-file', eventsFile);
  setOutput('events', Buffer.byteLength(json) <= INLINE_OUTPUT_LIMIT ? JSON.stringify(events) : '');
  setOutput('is-baseline', result.isBaseline);
  setOutput('complete', complete);

  const lines = [
    `### watch \`${key}\``,
    `${result.snapshot.items.length} items fetched, **${events.length} event(s)**${dryRun ? ' (dry run)' : ''}${result.isBaseline ? ' — baseline run' : ''}`,
  ];
  for (const e of events.slice(0, 50)) lines.push(`- \`${e.type}\` ${e.summary}`);
  if (events.length > 50) lines.push(`- …and ${events.length - 50} more`);
  appendSummary(lines.join('\n') + '\n');
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'poll') poll(rest);
  else throw new Error('usage: cli.ts poll [--key K --fetcher F --input JSON|YAML ...]');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`::error::${message.replace(/\n/g, '%0A')}`);
  console.error(message);
  process.exit(1);
}
