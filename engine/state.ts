// State is a directory holding state.json. The *action* decides how that directory is
// persisted (GitHub cache today); the engine only reads and writes files.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_VERSION } from './diff.ts';
import { isPlainObject } from './paths.ts';
import type { Data, State } from './types.ts';

export function readState(dir: string): State<Data> | null {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`state file ${file} is corrupt (${reason}). Delete the cache entry or change the key to start over.`);
  }
  if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION || !isPlainObject(parsed.items)) {
    throw new Error(`state file ${file} has an unsupported format (expected version ${STATE_VERSION})`);
  }
  return parsed as unknown as State<Data>;
}

export function writeState<DataType extends Data>(dir: string, state: State<DataType>): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 1));
  renameSync(file + '.tmp', file); // atomic: never leave a half-written state
}
