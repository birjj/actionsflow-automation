// Runs a fetcher: validates its input against fetcher.yml, executes `run` as a child
// process (env in, file out), and returns the parsed snapshot.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStructured } from './yaml-lite.ts';
import { applyDefaults, validate } from './schema.ts';
import { isPlainObject } from './paths.ts';
import type { Manifest } from './types.ts';

export function loadManifest(fetchersDir: string, name: string): { dir: string; manifest: Manifest } {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`invalid fetcher name "${name}"`);
  }
  const dir = resolve(fetchersDir, name);
  const file = join(dir, 'fetcher.yml');
  if (!existsSync(file)) throw new Error(`fetcher "${name}" not found (expected ${file})`);
  const manifest = parseStructured(readFileSync(file, 'utf8'));
  if (!isPlainObject(manifest) || typeof manifest.run !== 'string' || !manifest.run.trim()) {
    throw new Error(`${file}: "run" (a shell command) is required`);
  }
  return { dir, manifest: manifest as unknown as Manifest };
}

export interface RunFetcherArgs {
  fetchersDir: string;
  name: string;
  input?: Record<string, unknown>;
  outDir: string;
  timeoutMs?: number;
}

export function runFetcher(args: RunFetcherArgs): { snapshot: unknown; manifest: Manifest; input: unknown } {
  const { fetchersDir, name, input = {}, outDir, timeoutMs = 300_000 } = args;
  const { dir, manifest } = loadManifest(fetchersDir, name);

  const finalInput = applyDefaults(manifest.inputs, input);
  const errors = validate(manifest.inputs, finalInput);
  if (errors.length) throw new Error(`invalid input for fetcher "${name}":\n  ${errors.join('\n  ')}`);

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'fetcher-output.json');
  rmSync(outFile, { force: true });

  console.log(`▶ fetcher ${name}: ${manifest.run}`);
  const res = spawnSync(manifest.run, {
    shell: true,
    cwd: dir,
    stdio: 'inherit',
    timeout: timeoutMs,
    env: { ...process.env, FETCHER_INPUT: JSON.stringify(finalInput), FETCHER_OUTPUT: outFile, FETCHER_DIR: dir },
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ETIMEDOUT'
        ? `fetcher "${name}" timed out after ${timeoutMs / 1000}s`
        : `fetcher "${name}" failed to start: ${res.error.message}`,
    );
  }
  if (res.status !== 0) throw new Error(`fetcher "${name}" exited with code ${res.status ?? res.signal}`);
  if (!existsSync(outFile)) throw new Error(`fetcher "${name}" did not write FETCHER_OUTPUT`);

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch (err) {
    throw new Error(`fetcher "${name}" wrote invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { snapshot, manifest, input: finalInput };
}
