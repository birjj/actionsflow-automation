// The heart of the system. Everything in here is a pure function: no I/O, no clock
// (except an injectable `now`), no GitHub. Give it the previous state and a fresh
// snapshot, get back events and the state to persist.
import { collectChanges, deepEqual, getPath, isIgnored } from './paths.ts';
import type {
  Change, Data, Options, ResolvedOptions, State, StoredItem, ValidItem, ValidSnapshot, WatchEvent,
} from './types.ts';

const log = (...args: any[]) => console.log("[differ]", ...args);

export const STATE_VERSION = 1;

export function normalizeOptions(o: Options = {}): ResolvedOptions {
  const firstRun = o.firstRun ?? 'baseline';
  if (firstRun !== 'baseline' && firstRun !== 'emit') {
    throw new Error(`firstRun must be "baseline" or "emit", got "${String(firstRun)}"`);
  }
  return {
    added: o.added ?? true,
    removed: o.removed ?? false,
    changed: o.changed ?? [],
    ignore: o.ignore ?? [],
    firstRun,
  };
}

/** Validate and normalize a fetcher's output. Throws with a precise message on bad input. */
export function validateSnapshot<DataType extends Data>(raw: unknown): ValidSnapshot<DataType> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('snapshot must be an object like {"items": [...]}');
  }
  const snap = raw as { items?: unknown; complete?: unknown };
  if (!Array.isArray(snap.items)) throw new Error('snapshot.items must be an array');
  if (snap.complete !== undefined && typeof snap.complete !== 'boolean') {
    throw new Error('snapshot.complete must be a boolean when present');
  }
  const seen = new Set<string>();
  const items = snap.items.map((entry: unknown, i: number): ValidItem<DataType> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`items[${i}] must be an object`);
    }
    const it = entry as Record<string, unknown>;
    let id = it.id;
    if (typeof id === 'number' && Number.isFinite(id)) id = String(id);
    if (typeof id !== 'string' || id === '') {
      throw new Error(`items[${i}].id must be a non-empty string (got ${JSON.stringify(it.id)})`);
    }
    if (seen.has(id)) throw new Error(`duplicate item id "${id}" (ids must be unique within a snapshot)`);
    seen.add(id);
    if (it.title !== undefined && typeof it.title !== 'string') throw new Error(`items[${i}].title must be a string`);
    if (it.url !== undefined && typeof it.url !== 'string') throw new Error(`items[${i}].url must be a string`);
    const data = it.data ?? {};
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`items[${i}].data must be an object`);
    }
    return { id, title: it.title, url: it.url, data: data as DataType };
  });
  return { complete: snap.complete ?? true, items };
}

function itemsMap<DataType extends Data>(state: State<DataType> | null): Map<string, StoredItem<DataType>> {
  return new Map(Object.entries(state?.items ?? {}));
}

const label = (item: { id: string; title?: string | null }): string => item.title ?? item.id;

function fmt(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

function computeChanges<DataType extends Data>(oldData: DataType, newData: DataType, { changed, ignore }: ResolvedOptions): Change[] {
  if (changed.includes('*')) return collectChanges(oldData, newData, ignore);
  const out: Change[] = [];
  for (const path of changed) {
    if (isIgnored(path, ignore)) continue;
    const from = getPath(oldData, path);
    const to = getPath(newData, path);
    if (!deepEqual(from, to)) out.push({ path, from: from ?? null, to: to ?? null });
  }
  return out;
}

/** Events between a previous item map and a snapshot. */
export function diffSnapshots<DataType extends Data>(args: {
  key: string;
  previous: Map<string, StoredItem<DataType>>;
  snapshot: ValidSnapshot<DataType>;
  options?: Options;
}): WatchEvent[] {
  const { key, previous, snapshot } = args;
  const opts = normalizeOptions(args.options);
  const events: WatchEvent[] = [];
  const currentIds = new Set<string>();

  log(`Diffing previous snapshot (${previous.size} entries) with new snapshot (${snapshot.items.length} entries, complete=${snapshot.complete})`);

  for (const item of snapshot.items) {
    currentIds.add(item.id);
    const old = previous.get(item.id);
    const base = { key, id: item.id, title: item.title ?? null, url: item.url ?? null };
    if (!old) {
      if (opts.added) {
        log(`Observed new item`, label(item));
        events.push({ type: 'added', ...base, summary: `${label(item)} appeared`, data: item.data });
      }
    } else if (opts.changed.length) {
      const changes = computeChanges(old.data ?? {}, item.data, opts);
      if (changes.length) {
        const text = changes.map((c) => `${c.path || 'value'}: ${fmt(c.from)} → ${fmt(c.to)}`).join(', ');
        log(`Observed changed item`, label(item), { changes });
        events.push({
          type: 'changed', ...base, summary: `${label(item)}: ${text}`,
          changes, before: old.data ?? {}, data: item.data,
        });
      }
    }
  }

  // Only trust "missing" when the fetcher says it saw everything.
  if (opts.removed && snapshot.complete) {
    for (const [id, old] of previous) {
      if (currentIds.has(id)) continue;
      log(`Observed removed item`, label(old));
      events.push({
        type: 'removed', key, id, title: old.title ?? null, url: old.url ?? null,
        summary: `${label(old)} disappeared`, data: old.data ?? {},
      });
    }
  }
  return events;
}

/**
 * The state to persist after a snapshot. For incomplete snapshots, unseen items are
 * kept (so they don't look "new" when they reappear).
 */
export function buildNextState<DataType extends Data>(previous: State<DataType> | null, snapshot: ValidSnapshot<DataType>, now: Date = new Date()): State<DataType> {
  const items = snapshot.complete ? new Map<string, StoredItem<DataType>>() : itemsMap(previous);
  for (const it of snapshot.items) {
    items.set(it.id, { id: it.id, title: it.title, url: it.url, data: it.data });
  }
  return { version: STATE_VERSION, updatedAt: now.toISOString(), items: Object.fromEntries(items) };
}

export interface EvaluateResult<DataType extends Data> {
  events: WatchEvent[];
  state: State<DataType>;
  /** no previous state existed */
  isBaseline: boolean;
  /** false when `state` should not be saved */
  persist: boolean;
  snapshot: ValidSnapshot<DataType>;
}

/** One full evaluation: validate, diff, compute the next state. */
export function evaluate<DataType extends Data>(args: {
  key: string;
  state: State<DataType> | null;
  snapshot: unknown;
  options?: Options;
  now?: Date;
}): EvaluateResult<DataType> {
  const opts = normalizeOptions(args.options);
  const snapshot = validateSnapshot<DataType>(args.snapshot);
  const isBaseline = args.state == null;

  const state = buildNextState(args.state, snapshot, args.now);
  const events =
    isBaseline && opts.firstRun === 'baseline'
      ? []
      : diffSnapshots({ key: args.key, previous: itemsMap(args.state), snapshot, options: opts });

  // Baselining from a partial snapshot would later flood "added" events for whatever we
  // missed, so in that case don't persist and try again next run.
  const persist = !(isBaseline && !snapshot.complete);
  return { events, state, isBaseline, persist, snapshot };
}
