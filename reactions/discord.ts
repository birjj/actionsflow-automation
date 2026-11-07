// Posts events to a Discord webhook. Inputs come from env (set by the composite action):
//   DISCORD_WEBHOOK, EVENTS_FILE, TEMPLATE (optional), USERNAME (optional), MAX_MESSAGES (default 10)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { render } from '../engine/template.ts';
import type { WatchEvent } from '../engine/types.ts';

type DiscordEmbed = {
  title: string;
  description?: string;
  url?: string;
  image?: string;
};
/** https://docs.discord.com/developers/resources/webhook#execute-webhook */
type DiscordPayload = {
  username?: string;
  avatar_url?: string;
  allowed_mentions?: { parse: ("users"|"roles"|"everyone")[] | never[] }
  content?: string;
  embeds?: DiscordEmbed[];
}

const log = (...args: any[]) => console.log("[discord reaction]", ...args);
const EMOJI: Record<WatchEvent['type'], string> = { added: '🆕', changed: '🔄', removed: '🗑️' };

export function defaultTitle(e: WatchEvent): string {
  return `${EMOJI[e.type] ?? '•'} ${e.summary}${e.url ? `\n${e.url}` : ''}`;
}

export function eventToEmbed(e: WatchEvent, titleTemplate?: string, descriptionTemplate?: string): DiscordEmbed {
  const title = titleTemplate ? render(titleTemplate, e) : defaultTitle(e);
  const description = descriptionTemplate ? render(descriptionTemplate, e) : undefined;
  return {
    title: title.length > 256 ? title.slice(0, 256-1) + '…' : title,
    description: description && description.length > 512 ? description.slice(0, 512-1) + '…' : description,
    url: e.url || undefined,
    image: undefined,
  };
}

interface Transport {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}
/** Triggers the given Discord webhook */
async function post(webhook: string, body: DiscordPayload, { fetchImpl, sleep }: Transport): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.ceil(Number(info.retry_after ?? 1) * 1000) + 100);
      continue;
    }
    if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`);
    return;
  }
  throw new Error('Discord webhook kept rate-limiting us');
}

export interface SendMessagesArgs {
  events: WatchEvent[];
  webhook: string;
  titleTemplate?: string;
  descriptionTemplate?: string;
  username?: string;
  maxMessages?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
}
/** @returns number of events posted */
export async function sendMessageForEvents(args: SendMessagesArgs): Promise<number> {
  const {
    events, webhook, titleTemplate, descriptionTemplate, username, maxMessages = 10,
    fetchImpl = fetch, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pauseMs = 600,
  } = args;
  if (!events.length) return 0;
  const shown = events.slice(0, maxMessages);
  const discordPayload: DiscordPayload = {
    content: events.length > shown.length ? `${events.length} events (${events.length - shown.length} not shown here)` : undefined,
    username: username || undefined,
    allowed_mentions: { parse: [] },
    embeds: shown.map(event => eventToEmbed(event, titleTemplate, descriptionTemplate))
  };
  await post(webhook, discordPayload, { fetchImpl, sleep });
  return shown.length;
}

/** Runs the Discord reaction, posting a message with an embed for each event */
async function main(): Promise<void> {
  const { DISCORD_WEBHOOK: webhook, EVENTS_FILE: file, TITLE_TEMPLATE, DESCRIPTION_TEMPLATE, USERNAME, MAX_MESSAGES } = process.env;
  if (!file || !existsSync(file)) {
    log('No events file; nothing to send');
    return;
  }
  const events = JSON.parse(readFileSync(file, 'utf8')) as WatchEvent[];
  if (!events.length) {
    log('No events; nothing to send');
    return;
  }
  if (!webhook || !/^https:\/\//.test(webhook)) throw new Error('Webhook must be an HTTPS URL (is the secret set?)');
  log(`Sending ${events.length} events to Discord webhook`);
  const sent = await sendMessageForEvents({ events, webhook, titleTemplate: TITLE_TEMPLATE, descriptionTemplate: DESCRIPTION_TEMPLATE, username: USERNAME, maxMessages: Number(MAX_MESSAGES) || 10 });
  log(`Sent message with ${sent} embeds`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
