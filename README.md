# actionswatch

Scheduled GitHub Actions that **fetch** a list of things, **diff** it against what was seen last time, and let you **react** to what changed (Discord, a webhook, an issue, anything).

- A **fetcher** returns a *snapshot*: items with stable ids. It knows nothing about history.
- The **`poll` action** restores state, runs the fetcher, diffs, and emits *events* (`added` / `changed` / `removed`).
- A **reaction** is any step that reads the events file. `notify-discord` is included.
- Your **workflow** owns the schedule, the filters, and what happens next.

Written in **erasable-syntax TypeScript** that Node runs directly: no build step, no runtime dependencies. It needs Node ≥ 22.18 (type-stripping is on by default there; the actions install Node 24 for you). `typescript` and `@types/node` are dev-only, for `npm run typecheck`.

## Quick start

1. Copy this repo (or fork it).
2. Add a repository secret `DISCORD_WEBHOOK`.
3. Edit `.github/workflows/cat-watch.yml`: point `source:` at a real listing, adapt `normalize()` in `fetchers/adoptable-cats/main.ts` to that site.
4. Run the workflow once via **Actions → cat-watch → Run workflow** (this records the baseline), then let the schedule run.

Try it locally first:

```bash
npm install      # dev-only: typescript + @types/node
npm run typecheck
npm test
node engine/cli.ts poll --key demo --fetcher adoptable-cats --state-dir /tmp/demo-state \
  --input 'ids: [123]' \
  --watch-changed 'name,openForPatients,doctors'
```

## A workflow

```yaml
on:
  schedule: [{ cron: "0 6 * * *" }, { cron: "0 18 * * *" }]
concurrency: { group: service-watch, cancel-in-progress: false }   # state is read-modify-write
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: poll
        uses: ./.github/actions/poll
        with:
          key: service-status             # state namespace; [a-z0-9-]+
          fetcher: entity-state
          input: |
            entities: [alpha, beta, gamma]
            url_template: https://status.example.org/api/{id}.json
          watch-added: false
          watch-changed: status
      - uses: ./.github/actions/notify-discord
        with:
          webhook: ${{ secrets.DISCORD_WEBHOOK }}
          events-file: ${{ steps.poll.outputs.events-file }}
          template: "⚠️ {{id}}: {{changes.0.from}} → {{changes.0.to}}"
```

Varying behaviour by trigger is plain GitHub: several crons, `workflow_dispatch` inputs, and `github.event.schedule` in an `if:`.

## The fetcher contract

A fetcher is `fetchers/<name>/fetcher.yml` plus anything executable.

```yaml
name: adoptable-cats
run: node main.ts             # shell command, cwd = the fetcher's directory
inputs:                       # JSON Schema subset: type, enum, required, properties,
  type: object                # items, minimum/maximum, minLength, pattern, default,
  required: [source]          # additionalProperties:false
  properties:
    species: { type: string, default: cat }
ignore: [fetched_at]          # volatile data paths that never count as changes
```

| | |
|---|---|
| **In** | env `FETCHER_INPUT` (JSON, defaults applied and validated), `FETCHER_OUTPUT` (path to write), `FETCHER_DIR` |
| **Out** | JSON written to `FETCHER_OUTPUT`: `{ "complete": true, "items": [{ "id", "title?", "url?", "data?" }] }` |
| **Failure** | non-zero exit (or a timeout) fails the job and **does not touch state** |

- `id` must be unique and stable. `data` is arbitrary JSON; `watch-changed` paths are relative to it (`status`, `address.city`, `tags.0`).
- `title`/`url` are for reactions only and are never diffed.
- **`complete: false`** means "I might have missed items" (a page failed, a pagination cap was hit). Removals are suppressed and unseen items stay in state, so a flaky fetch can't cause a removal storm followed by an "everything is new" storm. Both bundled fetchers use this.
- Any language works. For TypeScript, `sdk/index.ts` gives typed `Item`/`Snapshot`/`FetcherContext<Input>`, `runIfMain(import.meta.url, collect)` and `fetchJson<T>` (timeout + retries). Declare an input interface matching your `fetcher.yml` schema and write `collect({ input, log }: FetcherContext<MyInput>): Promise<Snapshot>`.
- Relative paths in a fetcher's input (such as `source: sample.json`) resolve against the fetcher's own directory.

## The `poll` action

| Input | Default | |
|---|---|---|
| `key` | required | State namespace. Explicit, so renaming a workflow doesn't lose state. |
| `fetcher`, `input` | required, `{}` | `input` is JSON or a simple YAML subset (block maps/lists, single-line `[a, b]`/`{a: 1}`, quotes, comments). |
| `watch-added` | `true` | |
| `watch-removed` | `false` | Ignored for incomplete snapshots. |
| `watch-changed` | `` | Comma/newline separated data paths, or `*` for any leaf change. |
| `ignore` | `` | Extra ignored paths, merged with the fetcher's. |
| `first-run` | `baseline` | `baseline`: record state, emit nothing. `emit`: report everything. |
| `dry-run` | `false` | Compute events, don't advance state. |
| `fetchers-dir`, `timeout-seconds` | `fetchers`, `300` | |
| `node-version` | `24` | Must be ≥ 22.18 so Node can strip types by default. |

Outputs: `has-events`, `count`, `events-file`, `events` (inline JSON, empty if > ~200 KB), `is-baseline`, `complete`. A summary is also written to the job summary page.

### Events

```jsonc
{ "type": "added",   "key": "cats", "id": "4812", "title": "Mimi", "url": "…", "summary": "Mimi appeared", "data": { … } }
{ "type": "changed", "key": "svc", "id": "beta", "title": "beta", "summary": "beta: status: up → degraded",
  "changes": [{ "path": "status", "from": "up", "to": "degraded" }], "before": { … }, "data": { …current… } }
{ "type": "removed", "key": "cats", "id": "4001", "title": "…", "summary": "… disappeared", "data": { …last known… } }
```

A missing field and `null` are treated as equal.

## Reactions

- **`notify-discord`**: `webhook`, `events-file`, optional `template` (`{{title}}`, `{{changes.0.to}}`, `{{data.age_months}}`; missing values render empty), `username`, `max-messages` (default 10, then "…and N more"). No-ops on an empty list, so no `if:` guard. Mentions are disabled, so scraped text can't ping `@everyone`. Handles 429s.
- **Your own step:**
  ```yaml
  - if: steps.poll.outputs.has-events == 'true'
    run: jq -r '.[] | "\(.type): \(.summary)"' "$EVENTS_FILE"
    env: { EVENTS_FILE: "${{ steps.poll.outputs.events-file }}" }
  ```
- **Per-event fan-out:** `strategy.matrix.include: ${{ fromJSON(needs.watch.outputs.events) }}` (needs a job output; max 256 jobs, 1 MB). Use sparingly.
- **Adding a reaction** (ntfy, Telegram, open an issue…): copy `reactions/discord.ts` + `.github/actions/notify-discord/`. It's ~60 lines: read the events file, call an API.

## State and delivery semantics

State is a directory (`.watch-state/<key>/state.json`) persisted with `actions/cache`. The poll action restores the newest entry for the key; `actions/cache`'s post step saves a new entry at the end of the job **only if the job succeeded**. So if Discord is down, state doesn't advance and you're re-notified next run: **at-least-once**. (If some messages were sent before a failure, those repeat.)

Things to know:

- **Eviction:** caches unused for 7 days are deleted (10 GB/repo cap). If state vanishes, the run is a baseline (`is-baseline: true`): no flood, but changes during the gap are missed. Daily/twice-daily schedules keep it alive.
- **Public repos:** scheduled workflows are disabled after 60 days without repo activity.
- **Branches:** scheduled runs use the default branch's cache. Manual runs on other branches can read it but save to their own scope.
- **Concurrency:** keep a `concurrency:` group per watch; two overlapping runs would race.
- **Delays/skips:** harmless, since detection is diff-based, not time-based.
- **Corrupt state** fails loudly with instructions rather than silently re-baselining.
- State holds the full latest `data` of each item (needed for `before`). Keep `data` lean for huge lists.

## Security

Fetched data is untrusted. **Never interpolate `steps.poll.outputs.events` (or any event field) into `run:` text**: pass it via `env:` or read the events file. The bundled actions pass all inputs through env for that reason. Secrets a fetcher needs go in `env:` on the `poll` step.

## TypeScript notes

- Node only *erases* types, so the code sticks to erasable syntax: no `enum`, no `namespace` with values, no constructor parameter properties, no `import x = require()`. `tsconfig.json` sets `erasableSyntaxOnly`, so `npm run typecheck` catches slips (Node itself also refuses them at startup).
- Imports use explicit `.ts` extensions, and type-only imports use `import type` (`verbatimModuleSyntax`).
- Keep `"type": "module"` in `package.json`. Fetchers outside this repo's root should have it too (Node can usually detect ESM syntax, but `.mts` or the package setting is the reliable route).
- Node does not strip types in files under `node_modules`, which doesn't matter here (no dependencies), but means you can't publish these as an npm package without compiling.

## Layout

```
.github/actions/{poll,notify-discord}/   composite actions
.github/workflows/                       cat-watch, service-watch, ci
engine/                                  diff.ts (pure core), cli.ts, types.ts, fetcher runner, YAML-subset, schema, template
reactions/discord.ts
sdk/index.ts                             fetcher helpers + types
tsconfig.json                            type-check only (noEmit, erasableSyntaxOnly)
fetchers/{adoptable-cats,entity-state}/
test/                                    unit + end-to-end (real CLI, real fetchers, mock Discord server)
```

## Ideas for later

- A `git`-branch state backend (no eviction, free audit history): swap the cache step in `poll/action.yml` for checkout/commit of `state/<key>`; the engine only sees a directory, so nothing else changes.
- Per-event `ntfy` / generic `http-webhook` reactions; `watch-changed` expressions beyond paths (thresholds, regexes).
