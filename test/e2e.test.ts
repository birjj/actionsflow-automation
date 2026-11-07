// End-to-end: real CLI + real fetchers + a mock Discord server. Simulates consecutive
// scheduled runs by pointing every run at the same state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eventToEmbed, sendMessageForEvents } from '../reactions/discord.ts';
import type { WatchEvent } from '../engine/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'engine/cli.ts');

interface Env { dir: string; state: string; out: string; gh: string }

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  return { dir, state: join(dir, 'state'), out: join(dir, 'out'), gh: join(dir, 'gh-output') };
}

/** Run the CLI like the action does; returns exit info, parsed GITHUB_OUTPUT and events.json. */
function poll(env: Env, args: string[]) {
  writeFileSync(env.gh, '');
  const res = spawnSync(process.execPath, [CLI, 'poll', '--state-dir', env.state, '--out-dir', env.out,
    '--fetchers-dir', join(ROOT, 'fetchers'), ...args], {
    env: { ...process.env, GITHUB_OUTPUT: env.gh }, encoding: 'utf8',
  });
  const outputs: Record<string, string> = {};
  for (const m of readFileSync(env.gh, 'utf8').matchAll(/^(\S+?)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[m[1]!] = m[3]!;
  }
  const eventsPath = join(env.out, 'events.json');
  const events: WatchEvent[] = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  return { status: res.status, stderr: res.stderr, outputs, events };
}

test('bad input and bad fetchers fail loudly without touching state', () => {
  const env = makeEnv();
  const bad = poll(env, ['--key', 'x', '--fetcher', 'entity-state', '--input', 'entities: [a]']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /"entity-state" not found/);
  assert.ok(!existsSync(join(env.state, 'state.json')));
  assert.notEqual(poll(env, ['--key', 'x', '--fetcher', '../evil']).status, 0);
  assert.notEqual(poll(env, ['--key', 'Bad Key', '--fetcher', 'adoptable-cats']).status, 0);
});

// ---------- Discord reaction ----------
type HookHandler = (requestNumber: number, res: ServerResponse) => void;

async function withServer(handler: HookHandler, fn: (url: string, received: any[]) => Promise<void>): Promise<void> {
  const received: unknown[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { received.push(JSON.parse(body)); handler(++n, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received);
  } finally {
    server.close();
  }
}

const ev = (i: number, extra: Partial<WatchEvent> = {}): WatchEvent =>
  ({ type: 'added', key: 'k', id: String(i), title: `Cat ${i}`, url: `https://x/${i}`, summary: `Cat ${i} appeared`, data: {}, ...extra }) as WatchEvent;

test('discord: templates, mention suppression, cap with "N not shown here"', async () => {
  await withServer((_n, res) => { res.statusCode = 204; res.end(); }, async (url, received) => {
    const sent = await sendMessageForEvents({ events: [1, 2, 3].map((i) => ev(i, { title: '@everyone' })), webhook: url, titleTemplate: '🐱 {{title}} {{url}}', maxMessages: 2, pauseMs: 0 });
    assert.equal(sent, 2);
    assert.equal(received[0].embeds[0].title, '🐱 @everyone https://x/1');
    assert.deepEqual(received[0].allowed_mentions, { parse: [] });
    assert.match(received[0].content, /1 not shown here/);
  });
});

test('discord: retries on 429, throws on other errors', async () => {
  await withServer((n, res) => {
    if (n === 1) { res.statusCode = 429; res.setHeader('content-type', 'application/json'); res.end('{"retry_after":0.01}'); }
    else { res.statusCode = 204; res.end(); }
  }, async (url, received) => {
    await sendMessageForEvents({ events: [ev(1)], webhook: url, pauseMs: 0 });
    assert.equal(received.length, 2);
  });
  await withServer((_n, res) => { res.statusCode = 500; res.end(); }, async (url) => {
    await assert.rejects(sendMessageForEvents({ events: [ev(1)], webhook: url }), /HTTP 500/);
  });
});

test('discord: default messages per event type, truncation', () => {
  assert.equal(eventToEmbed(ev(1)).title, '🆕 Cat 1 appeared\nhttps://x/1');
  assert.ok(eventToEmbed(ev(1, { summary: 'x'.repeat(5000) })).title.length <= 256);
  assert.equal(eventToEmbed({ ...ev(1), type: 'changed', summary: 's', url: null } as WatchEvent).title, '🔄 s');
});

test('discord CLI is a no-op for empty events and errors without a webhook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd-'));
  const f = join(dir, 'events.json');
  writeFileSync(f, '[]');
  const bin = join(ROOT, 'reactions/discord.ts');
  assert.equal(spawnSync(process.execPath, [bin], { env: { ...process.env, EVENTS_FILE: f } }).status, 0);
  writeFileSync(f, JSON.stringify([ev(1)]));
  assert.notEqual(spawnSync(process.execPath, [bin], { env: { ...process.env, EVENTS_FILE: f, DISCORD_WEBHOOK: '' } }).status, 0);
});
