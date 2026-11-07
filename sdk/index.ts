// Fetcher SDK. A fetcher is any executable; this is just a convenience for TS/JS.
//
//   import { runIfMain, type FetcherContext, type Snapshot } from '../../sdk/index.ts';
//   export async function collect({ input, log }: FetcherContext<MyInput>): Promise<Snapshot> { ... }
//   await runIfMain(import.meta.url, collect);
//
// Exporting `collect` separately keeps it unit-testable; runIfMain only runs it when
// the file is executed directly.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Data, Item, Snapshot } from '../engine/types.ts';

export type { Item, Snapshot } from '../engine/types.ts';

/** The object a fetcher is given as its only parameter, containing the context of its call */
export interface FetcherContext<InputType> {
  /** FETCHER_INPUT, after the framework applied schema defaults and validation */
  input: InputType;
  /** Helper function to log information */
  log: (...args: unknown[]) => void;
}
/** A single fetcher */
export type Fetcher<InputType, DataType extends Data> = (
  ctx: FetcherContext<InputType>,
) => Promise<Snapshot<DataType> | Item<DataType>[]> | Snapshot<DataType> | Item<DataType>[];

/** Gets the input from the current env vars; assumes they have been validated */
export function getInput<InputType>(): InputType {
  return JSON.parse(process.env.FETCHER_INPUT ?? '{}') as InputType;
}

export async function runFetcher<InputType, DataType extends Data>(fetcher: Fetcher<InputType, DataType>): Promise<void> {
  const out = process.env.FETCHER_OUTPUT;
  if (!out) throw new Error('FETCHER_OUTPUT is not set (run this through the framework, or set it manually)');
  const result = await fetcher({ input: getInput<InputType>(), log: (...a) => console.log(...a) });
  const snapshot: Snapshot<DataType> = Array.isArray(result) ? { complete: true, items: result } : result;
  writeFileSync(out, JSON.stringify(snapshot));
}

export async function runIfMain<InputType, DataType extends Data>(metaUrl: string, handler: Fetcher<InputType, DataType>): Promise<void> {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl)) {
    try {
      await runFetcher(handler);
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  }
}

export interface FetchJsonOptions {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

/** GET + parse JSON with a timeout and a couple of retries on network/5xx errors. */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { retries = 2, timeoutMs = 20_000, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500) throw new HttpError(`HTTP ${res.status}`, false);
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, true); // 4xx: retrying won't help
      return (await res.json());
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.fatal) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
