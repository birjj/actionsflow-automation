// Shared types. Imported with `import type`, so this file is erased entirely at runtime.

/** Arbitrary JSON object: what fetchers put in `item.data`. */
export type Data = Record<string, unknown>;

/** What a fetcher returns per item. */
export interface Item<T extends Data> {
  /** Unique and stable across runs. */
  id: string;
  title?: string;
  url?: string;
  /** `watch-changed` paths are relative to this object. */
  data?: T;
}

/** What a fetcher writes to FETCHER_OUTPUT. */
export interface Snapshot<T extends Data> {
  /** false = "I may have missed items": suppresses `removed` events. Default true. */
  complete?: boolean;
  items: Item<T>[];
}

/** A snapshot after validation/normalization. */
export interface ValidItem<T extends Data> {
  id: string;
  title: string | undefined;
  url: string | undefined;
  data: T;
}
export interface ValidSnapshot<T extends Data> {
  complete: boolean;
  items: ValidItem<T>[];
}

export type StoredItem<T extends Data> = ValidItem<T>;

export interface State<DataType extends Data> {
  version: 1;
  updatedAt: string;
  items: Record<string, StoredItem<DataType>>;
}

export interface Options {
  /** emit `added` events (default true) */
  added?: boolean;
  /** emit `removed` events, only for complete snapshots (default false) */
  removed?: boolean;
  /** data paths to watch, or ['*'] for any leaf change (default none) */
  changed?: string[];
  /** data paths that never count as a change */
  ignore?: string[];
  /** `baseline`: record state and emit nothing. `emit`: report everything. */
  firstRun?: 'baseline' | 'emit';
}
export type ResolvedOptions = Required<Options>;

export interface Change {
  path: string;
  from: unknown;
  to: unknown;
}

interface EventBase {
  key: string;
  id: string;
  title: string | null;
  url: string | null;
  summary: string;
}
export interface AddedEvent extends EventBase {
  type: 'added';
  data: Data;
}
export interface ChangedEvent extends EventBase {
  type: 'changed';
  changes: Change[];
  before: Data;
  /** current data */
  data: Data;
}
export interface RemovedEvent extends EventBase {
  type: 'removed';
  /** last known data */
  data: Data;
}
export type WatchEvent = AddedEvent | ChangedEvent | RemovedEvent;

/** Minimal JSON Schema subset used for fetcher `inputs`. */
export interface Schema {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
}

export interface Manifest {
  name?: string;
  description?: string;
  /** shell command, run with cwd = the fetcher's directory */
  run: string;
  inputs?: Schema;
  /** volatile data paths that never count as changes */
  ignore?: string[];
}
