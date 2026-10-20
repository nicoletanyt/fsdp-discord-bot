import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { Store } from '../src/store.js';
import { History } from '../src/history.js';
import { RequestBudget, makeRedactor } from '../src/security.js';
import { fixture } from './helpers.js';

test('FTS ranks match-centered excerpts and isolates guilds/channels; edits and deletes update the index', () => {
  const store = new Store(':memory:');
  const add = (id: string, guild: string, channel: string, content: string) => store.upsert({
    id, guild_id: guild, channel_id: channel, parent_id: null, author: 'alice', content, timestamp: Date.now(),
  });
  try {
    add('1', 'guild', 'approved', `${'background '.repeat(300)} uniqueNeedle discussion`);
    add('2', 'other-guild', 'approved', 'uniqueNeedle private');
    add('3', 'guild', 'other-channel', 'uniqueNeedle restricted');
    const results = store.search('guild', ['approved'], 'uniqueNeedle OR "', 10);
    assert.equal(results.length, 1);
    assert.match(results[0]!.content, /uniqueNeedle/);
    assert.ok(results[0]!.content.length < 1000);
    add('1', 'guild', 'approved', 'edited content');
    assert.equal(store.search('guild', ['approved'], 'uniqueNeedle', 10).length, 0);
    assert.equal(store.search('guild', ['approved'], 'edited', 10).length, 1);
    store.delete('1');
    assert.equal(store.search('guild', ['approved'], 'edited', 10).length, 0);
    assert.deepEqual(store.search('guild', [], '*', 10), []);
  } finally { store.close(); }
});

test('Discord search and context share byte/result budgets, deduplicate and recheck bot/requester permissions', async () => {
  const f = await fixture();
  const store = new Store(':memory:');
  let userVisible = true;
  let botVisible = true;
  let permissionChecks = 0;
  const bot = { id: 'bot' };
  const channel = {
    id: '222222222222222222', guildId: f.config.guildId, type: ChannelType.GuildText,
    permissionsFor: (member: {id: string}) => ({ has: () => { permissionChecks++; return member.id === 'bot' ? botVisible : userVisible; } }),
  };
  const member: any = { id: 'requester', guild: {
    channels: { fetch: async () => channel },
    members: { fetch: async () => member, fetchMe: async () => bot },
  } };
  for (let i = 0; i < 20; i++) store.upsert({
    id: String(333333333333333330n + BigInt(i)), guild_id: f.config.guildId,
    channel_id: channel.id, parent_id: null, author: 'alice',
    content: `deployment needle ${'🍀'.repeat(200)} fake-google-key-for-test`, timestamp: 1000 + i,
  });
  const history = new History({} as any, f.config, store, makeRedactor([f.config.apiKey]));
  try {
    const budget = new RequestBudget(5, 3);
    const [search, context] = history.tools(budget, member);
    let returned = '';
    for (let i = 0; i < 3; i++) {
      const result = await search!.execute('test', { query: 'needle' }, undefined, undefined, {} as any);
      const text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
      if (text.startsWith('https://')) returned += text;
    }
    assert.ok(budget.discordCount <= 10);
    assert.ok(budget.discordBytes <= 2000);
    assert.equal(budget.discordBytes, Buffer.byteLength(returned));
    assert.ok(permissionChecks >= 6);
    assert.ok(!returned.includes(f.config.apiKey));
    const ids = [...returned.matchAll(/https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    await assert.rejects(context!.execute('test', { message_id: '999999999999999999' }, undefined, undefined, {} as any), /Search/);
    userVisible = false;
    const denied = await history.tools(new RequestBudget(5, 3), member)[0]!.execute('test', { query: 'needle' }, undefined, undefined, {} as any);
    assert.ok(!JSON.stringify(denied).includes('deployment'));
    userVisible = true; botVisible = false;
    const botDenied = await history.tools(new RequestBudget(5, 3), member)[0]!.execute('test', { query: 'needle' }, undefined, undefined, {} as any);
    assert.ok(!JSON.stringify(botDenied).includes('deployment'));
    assert.equal(history.allowed({ ...channel, type: ChannelType.PrivateThread }), false);
    assert.equal(history.allowed({ ...channel, id: '444444444444444444', type: ChannelType.PublicThread, parentId: channel.id }), true);
  } finally { store.close(); await f.cleanup(); }
});

test('ten-result ceiling holds even with tiny Discord messages', async () => {
  const f = await fixture();
  f.config.discordBytes = 2000;
  const store = new Store(':memory:');
  const channel = { id: '222222222222222222', guildId: f.config.guildId, type: ChannelType.GuildText, permissionsFor: () => ({has: () => true}) };
  const member: any = { id: 'requester', guild: {channels: {fetch: async () => channel}, members: {fetch: async () => member, fetchMe: async () => member}} };
  for (let i = 0; i < 30; i++) store.upsert({ id: String(333333333333333330n + BigInt(i)), guild_id: f.config.guildId, channel_id: channel.id, parent_id: null, author: 'a', content: 'needle', timestamp: i });
  try {
    const budget = new RequestBudget(5, 3);
    const tool = new History({} as any, f.config, store, text => text).tools(budget, member)[0]!;
    for (let i = 0; i < 5; i++) await tool.execute('test', {query: 'needle'}, undefined, undefined, {} as any);
    assert.equal(budget.discordCount, 10);
    assert.ok(budget.discordBytes <= 2000);
  } finally { store.close(); await f.cleanup(); }
});
