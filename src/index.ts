import { mkdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, SlashCommandBuilder } from 'discord.js';
import { loadConfig } from './config.js';
import { makeRedactor, RequestBudget } from './security.js';
import { Store } from './store.js';
import { ResearchAgent } from './agent.js';
import { Repository } from './repository.js';
import { History } from './history.js';
import { BusyError, RequestQueue } from './concurrency.js';
import { safeFailure } from './diagnostics.js';

process.umask(0o077);
const config = loadConfig();
const redact = makeRedactor(Object.entries(process.env).filter(([name]) => /key|token|secret|password/i.test(name)).map(([, value]) => value ?? ''));
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
// Check canonical paths as well as configured paths, so symlink aliases cannot expose bot data.
const dataPath = await realpath(config.dataDir);
const repoPath = await realpath(config.repoPath);
for (const [parent, child] of [[dataPath, repoPath], [repoPath, dataPath]] as const) {
  const rel = relative(parent, child);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Repository and data paths overlap');
}
const store = new Store(join(config.dataDir, 'discord.sqlite'));
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel], allowedMentions: { parse: [], repliedUser: false },
});
const repository = new Repository(config, redact);
const history = new History(client, config, store, redact);
const agent = new ResearchAgent(config, store, redact);
const queue = new RequestQueue(config.maxConcurrent, config.maxQueue);
const cooldowns = new Map<string, number>();
let closing = false;

client.on(Events.Error, () => console.warn('Discord client error; reconnect handling is active'));
client.rest.on('rateLimited', () => console.warn('Discord rate limit encountered; REST requests are queued'));
client.on(Events.MessageCreate, message => {
  void (async () => {
    if (closing || !history.allowed(message.channel) || message.author.bot) return;
    history.save(message);
    if (!client.user || !message.mentions.users.has(client.user.id)) return;
    const prompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!prompt) { await message.reply('Mention me with a question about the repository or Discord discussions.'); return; }
    if (Buffer.byteLength(prompt) > config.maxInputBytes) { await message.reply('Please shorten your question.'); return; }
    const now = Date.now();
    const cooldownKey = `${message.guildId}-${message.author.id}`;
    if (now - (cooldowns.get(cooldownKey) ?? 0) < config.cooldownMs) {
      await message.reply('Please wait a moment before sending another question.'); return;
    }
    cooldowns.set(cooldownKey, now);
    for (const [key, timestamp] of cooldowns) if (now - timestamp > config.cooldownMs) cooldowns.delete(key);
    const scope = `${message.guildId}-${message.channelId}`;
    const started = performance.now();
    let stage = 'queue';
    try {
      await queue.run(scope, async () => {
        stage = 'member_fetch';
        const member = await message.guild!.members.fetch({ user: message.author.id, force: true });
        const budget = new RequestBudget(config.maxToolCalls, config.maxRepoFiles);
        stage = 'typing';
        if ('sendTyping' in message.channel) await message.channel.sendTyping();
        const typing = setInterval(() => {
          if ('sendTyping' in message.channel) void message.channel.sendTyping().catch(() => {});
        }, 8000);
        try {
          stage = 'model';
          const answer = await agent.answer(scope, prompt, budget, [
            ...repository.tools(budget, prompt), ...history.tools(budget, member),
          ]);
          stage = 'reply';
          for (let offset = 0; offset < answer.length; offset += 1900) await message.reply(answer.slice(offset, offset + 1900));
        } finally { clearInterval(typing); }
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'discord_request_failed', stage,
        durationMs: Math.round(performance.now() - started), ...(stage !== 'model' && stage !== 'reply' && { modelCallCount: 0 }),
        ...(error instanceof BusyError ? { category: 'queue_full' } : { failure: safeFailure(error) }) }));
      await message.reply(error instanceof BusyError ? 'I’m busy. Please try again shortly.' : 'I couldn’t complete that request. Please try a narrower question or retry shortly.');
    }
  })().catch(() => console.warn('Discord message handling failed'));
});
client.on(Events.MessageUpdate, (_old, message) => {
  void (async () => {
    if (!history.allowed(message.channel)) return;
    if (message.partial) message = await message.fetch();
    // Deletes the old index entry if the new content is empty or no longer indexable.
    store.delete(message.id); history.save(message);
  })().catch(() => console.warn('Discord message update failed'));
});
client.on(Events.MessageDelete, message => { if (history.allowed(message.channel)) store.delete(message.id); });
client.on(Events.MessageBulkDelete, messages => { for (const message of messages.values()) if (history.allowed(message.channel)) store.delete(message.id); });
client.on(Events.InteractionCreate, interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'usage') return;
  void (async () => {
    if (!interaction.channel || !history.allowed(interaction.channel)) {
      await interaction.reply({ content: 'This command is only available in approved channels.', flags: MessageFlags.Ephemeral }); return;
    }
    const usage = store.usage(`${interaction.guildId}-${interaction.channelId}`);
    await interaction.reply({ content: [
      '**AI usage for this channel/thread (all time)**',
      `API responses: ${usage.calls} | Input: ${usage.input} | Output: ${usage.output}`,
      `Cache read: ${usage.cache_read} | Cache write: ${usage.cache_write}`,
      `Estimated API cost: $${usage.cost.toFixed(6)} USD`,
      'Provider-reported tokens; failed calls are included when usage is returned. Cost is based on Pi’s model catalog.',
    ].join('\n'), flags: MessageFlags.Ephemeral });
  })().catch(() => console.warn('Usage command failed'));
});
client.once(Events.ClientReady, ready => {
  void (async () => {
    await history.start();
    const guild = await ready.guilds.fetch(config.guildId);
    const command = new SlashCommandBuilder().setName('usage').setDescription('Show AI token usage for this channel or thread');
    // Upsert just this command, preserving unrelated guild commands.
    const commands = await guild.commands.fetch();
    const existing = commands.find(item => item.name === 'usage');
    if (existing) await guild.commands.edit(existing.id, command.toJSON());
    else await guild.commands.create(command.toJSON());
    console.info(`Discord agent ready as ${ready.user.tag}`);
  })().catch(() => console.error('Discord startup registration failed; verify guild and command permissions'));
});

async function shutdown() {
  if (closing) return;
  closing = true;
  // Reject queued work, abort active sessions, then close storage.
  const forceExit = setTimeout(() => process.exit(1), 30000);
  forceExit.unref();
  const drained = queue.close();
  await agent.close();
  await drained;
  await Promise.all([history.close(), repository.close()]);
  await client.destroy(); store.close();
  clearTimeout(forceExit);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
try {
  await repository.initialize();
  await agent.initialize();
  await client.login(config.discordToken);
} catch {
  console.error('Startup failed. Check configuration, repository access, AI credentials and Discord token.');
  await shutdown(); process.exitCode = 1;
}
