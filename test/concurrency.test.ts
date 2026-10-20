import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue, BusyError, withAbort } from '../src/concurrency.js';
import { loadConfig } from '../src/config.js';

test('same-channel work serializes, other channels proceed, overflow is rejected and failures release slots', async () => {
  const queue = new RequestQueue(2, 1);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const first = queue.run('channel-a', async () => { events.push('a1'); await barrier; });
  const second = queue.run('channel-a', async () => { events.push('a2'); throw new Error('expected'); });
  const rejectedSecond = assert.rejects(second, /expected/);
  await assert.rejects(queue.run('channel-a', async () => {}), BusyError);
  await queue.run('channel-b', async () => { events.push('b1'); });
  assert.deepEqual(events, ['a1', 'b1']);
  release(); await first; await rejectedSecond;
  await queue.run('channel-a', async () => { events.push('a3'); });
  assert.deepEqual(events, ['a1', 'b1', 'a2', 'a3']);
  await queue.close();
});

test('shutdown rejects queued work and abort stops waiting on an outstanding REST call', async () => {
  const queue = new RequestQueue(1, 1);
  const controller = new AbortController();
  const active = queue.run('active', () => withAbort(new Promise<void>(() => {}), controller.signal));
  const activeRejected = assert.rejects(active, /aborted/);
  const queued = assert.rejects(queue.run('queued', async () => assert.fail('queued work started during shutdown')), BusyError);
  const closed = queue.close();
  controller.abort();
  await Promise.all([activeRejected, queued, closed]);
});

test('configuration rejects ceiling overrides and overlapping state/repository paths', () => {
  const env = { DISCORD_TOKEN: 'fake', AI_API_KEY: 'fake', DISCORD_GUILD_ID: '111111111111111111', DISCORD_ALLOWED_CHANNEL_IDS: '222222222222222222', REPO_PATH: '/tmp/repo', DATA_DIR: '/tmp/data' };
  for (const [setting, value] of [['MAX_TOOL_CALLS', '6'], ['MAX_REPO_FILES', '4'], ['DISCORD_MAX_RESULTS', '11'], ['DISCORD_TOKEN_BUDGET', '2001']]) {
    assert.throws(() => loadConfig({...env, [setting!]: value}), /must be an integer/);
  }
  assert.throws(() => loadConfig({...env, DATA_DIR: '/tmp/repo/state'}), /non-nested/);
});
