import { ChannelType, PermissionFlagsBits, type Client, type GuildMember, type Message, type GuildBasedChannel } from 'discord.js';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.js';
import { Store, messageLink, type StoredMessage } from './store.js';
import { clip, RequestBudget } from './security.js';
import { withAbort } from './concurrency.js';

export class History {
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  constructor(private client: Client, private config: Config, private store: Store, private redact: (text: string) => string) {}
  allowed(channel: { id: string; guildId?: string | null; parentId?: string | null; type: ChannelType }): boolean {
    if (channel.guildId !== this.config.guildId || channel.type === ChannelType.PrivateThread) return false;
    const thread = channel.type === ChannelType.PublicThread || channel.type === ChannelType.AnnouncementThread;
    return this.config.allowedChannels.has(channel.id) || (thread && !!channel.parentId && this.config.allowedChannels.has(channel.parentId));
  }
  private visible(channel: GuildBasedChannel, member: GuildMember) {
    const permissions = channel.permissionsFor(member);
    return this.allowed(channel) && !!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  }
  save(message: Message) {
    if (!this.allowed(message.channel) || message.author.bot || !message.content) return;
    this.store.upsert({
      id: message.id, guild_id: message.guildId!, channel_id: message.channelId,
      parent_id: 'parentId' in message.channel ? message.channel.parentId : null,
      author: this.redact(message.author.username), content: clip(this.redact(message.content), 16000), timestamp: message.createdTimestamp,
    });
  }
  async start() {
    // Index in the background so mentions work while the bounded startup backfill runs.
    void this.sync();
    this.timer = setInterval(() => { void this.sync(); }, this.config.historySyncMs);
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.index().catch(() => { console.warn('Discord history sync failed; live indexing remains active'); })
      .finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async index() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const scopes = new Map<string, GuildBasedChannel>();
    for (const id of this.config.allowedChannels) {
      try {
        const channel = await guild.channels.fetch(id);
        if (channel && this.allowed(channel)) scopes.set(id, channel);
      } catch { console.warn('An approved Discord channel could not be indexed'); }
    }
    for (const channel of [...scopes.values()]) {
      try {
        if (scopes.size < this.config.maxHistoryScopes && 'threads' in channel && !channel.isThread()) {
          const active = await channel.threads.fetchActive();
          for (const thread of active.threads.values()) {
            if (scopes.size >= this.config.maxHistoryScopes) break;
            if (this.allowed(thread)) scopes.set(thread.id, thread);
          }
          if (this.config.archivedThreads > 0 && scopes.size < this.config.maxHistoryScopes) {
            const archived = await channel.threads.fetchArchived({ type: 'public', limit: this.config.archivedThreads });
            for (const thread of archived.threads.values()) {
              if (scopes.size >= this.config.maxHistoryScopes) break;
              if (this.allowed(thread)) scopes.set(thread.id, thread);
            }
          }
        }
      } catch { console.warn('An approved Discord channel could not be indexed'); }
    }
    for (const channel of scopes.values()) {
      if (!channel.isTextBased() || !('messages' in channel)) continue;
      try {
        let before: string | undefined;
        let remaining = this.config.historyBackfill;
        while (remaining > 0) {
          const messages = await channel.messages.fetch({ limit: Math.min(100, remaining), before, cache: false });
          if (!messages.size) break;
          for (const message of messages.values()) this.save(message);
          remaining -= messages.size; before = messages.last()!.id;
          if (messages.size < Math.min(100, remaining + messages.size)) break;
        }
      } catch { console.warn('History unavailable for an approved channel'); }
    }
  }
  private async visibleScopes(member: GuildMember, signal?: AbortSignal, targetChannel?: string): Promise<string[]> {
    const scopes: string[] = [];
    // Refetch membership so role changes are respected even during a long queue wait.
    signal?.throwIfAborted();
    member = await withAbort(member.guild.members.fetch({ user: member.id, force: true }), signal);
    const bot = await withAbort(member.guild.members.fetchMe({ force: true }), signal);
    const candidates = targetChannel ? [targetChannel] : this.store.scopes(this.config.guildId, this.config.maxHistoryScopes);
    for (const id of candidates) {
      signal?.throwIfAborted();
      try {
        const channel = await withAbort(member.guild.channels.fetch(id, { force: true }), signal);
        signal?.throwIfAborted();
        if (channel && this.visible(channel, member) && this.visible(channel, bot)) scopes.push(id);
      } catch { /* Deleted or inaccessible channels are excluded. */ }
    }
    return scopes;
  }
  tools(budget: RequestBudget, member: GuildMember) {
    const delivered = new Set<string>();
    const pack = (messages: StoredMessage[], targetBytes: number) => {
      const available = Math.min(targetBytes, this.config.discordBytes - budget.discordBytes);
      const rows: string[] = [];
      for (const message of messages) {
        if (delivered.has(message.id) || budget.discordCount >= this.config.discordResults) continue;
        const header = `${messageLink(message)} | ${new Date(message.timestamp).toISOString()} | ${this.redact(message.author)}\n`;
        const room = available - Buffer.byteLength(rows.join('\n\n')) - (rows.length ? 2 : 0);
        const headerBytes = Buffer.byteLength(header);
        if (room < headerBytes + 40) break;
        const row = header + clip(this.redact(message.content), Math.min(400, room - headerBytes));
        rows.push(row); delivered.add(message.id); budget.discordAnchors.set(message.id, message.channel_id); budget.discordCount++;
      }
      const text = rows.join('\n\n');
      budget.discordBytes += Buffer.byteLength(text);
      return { content: [{ type: 'text' as const, text: text || 'No further relevant messages available within access and retrieval limits.' }], details: {} };
    };
    return [
      defineTool({
        name: 'discord_search', label: 'Discord keyword search',
        description: 'FTS keyword search across approved channels visible to this requester. Returns relevant excerpts with message links. Refine keywords rather than reading entire histories.',
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), channel_id: Type.Optional(Type.String({ pattern: '^\\d{17,20}$' })) }),
        execute: async (_id, { query, channel_id }, signal) => {
          const scopes = await this.visibleScopes(member, signal, channel_id);
          signal?.throwIfAborted();
          return pack(this.store.search(this.config.guildId, scopes, query, this.config.discordResults), Math.min(1200, this.config.discordBytes));
        },
      }),
      defineTool({
        name: 'discord_context', label: 'Discord discussion context',
        description: 'Retrieve nearby indexed messages around a message ID returned by discord_search. Shares the same per-request 10-result / 2000-token budget.',
        parameters: Type.Object({ message_id: Type.String({ pattern: '^\\d{17,20}$' }) }),
        execute: async (_id, { message_id }, signal) => {
          if (!budget.discordAnchors.has(message_id)) throw new Error('Search for this message first');
          const scopes = await this.visibleScopes(member, signal, budget.discordAnchors.get(message_id));
          signal?.throwIfAborted();
          return pack(this.store.around(this.config.guildId, scopes, message_id, this.config.discordResults), this.config.discordBytes);
        },
      }),
    ];
  }
  async close() { clearInterval(this.timer); await this.syncing; }
}
