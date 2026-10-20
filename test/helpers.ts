import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

export async function fixture() {
  const parent = fileURLToPath(new URL('./.tmp/', import.meta.url));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'fixture-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  await Promise.all([mkdir(repo), mkdir(data)]);
  const config = loadConfig({
    DISCORD_TOKEN: 'fake-discord-token-for-test', AI_API_KEY: 'fake-google-key-for-test',
    DISCORD_GUILD_ID: '111111111111111111', DISCORD_ALLOWED_CHANNEL_IDS: '222222222222222222',
    REPO_PATH: repo, DATA_DIR: data, API_RETRIES: '0',
  });
  return { root, repo, data, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}
