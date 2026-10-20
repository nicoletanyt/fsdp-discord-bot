import { resolve, relative, isAbsolute } from 'node:path';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const ids = required('DISCORD_ALLOWED_CHANNEL_IDS').split(',').map(x => x.trim());
  const guildId = required('DISCORD_GUILD_ID');
  if (![guildId, ...ids].every(id => /^\d{17,20}$/.test(id))) throw new Error('Invalid Discord IDs');
  const repoPath = resolve(required('REPO_PATH'));
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (inside(repoPath, dataDir) || inside(dataDir, repoPath)) {
    throw new Error('REPO_PATH and DATA_DIR must be separate, non-nested directories');
  }
  const maxHistoryScopes = integer('HISTORY_MAX_SCOPES', 100, 1, 500);
  if (ids.length > maxHistoryScopes) throw new Error('Approved channels exceed HISTORY_MAX_SCOPES');
  return {
    discordToken: required('DISCORD_TOKEN'), guildId, allowedChannels: new Set(ids),
    apiKey: required('AI_API_KEY'), provider: env.AI_PROVIDER ?? 'google',
    model: env.AI_MODEL ?? 'gemini-2.5-flash', repoPath, dataDir,
    repoBranch: env.REPO_BRANCH ?? 'main',
    historySyncMs: integer('HISTORY_SYNC_SECONDS', 300, 30, 86400) * 1000,
    historyBackfill: integer('HISTORY_BACKFILL_MESSAGES', 500, 0, 10000),
    archivedThreads: integer('HISTORY_ARCHIVED_THREADS', 20, 0, 100),
    maxHistoryScopes,
    maxToolCalls: integer('MAX_TOOL_CALLS', 5, 1, 5),
    maxRepoFiles: integer('MAX_REPO_FILES', 3, 1, 3),
    maxReadLines: integer('MAX_READ_LINES', 100, 1, 200),
    maxFileBytes: integer('MAX_FILE_BYTES', 1000000, 1024, 10000000),
    toolResultBytes: integer('TOOL_RESULT_BYTES', 6000, 512, 8000),
    discordResults: integer('DISCORD_MAX_RESULTS', 10, 1, 10),
    // One UTF-8 byte per token is deliberately conservative; no tokenizer dependency.
    discordBytes: integer('DISCORD_TOKEN_BUDGET', 2000, 256, 2000),
    maxInputBytes: integer('MAX_INPUT_BYTES', 6000, 256, 12000),
    contextBytes: integer('CONTEXT_BYTES', 48000, 16000, 64000),
    contextTurns: integer('CONTEXT_TURNS', 3, 0, 10),
    maxOutputTokens: integer('MAX_OUTPUT_TOKENS', 1500, 128, 4000),
    maxModelCalls: integer('MAX_MODEL_CALLS', 9, 1, 12),
    requestTimeoutMs: integer('REQUEST_TIMEOUT_SECONDS', 120, 10, 600) * 1000,
    maxConcurrent: integer('MAX_CONCURRENT_REQUESTS', 2, 1, 10),
    maxQueue: integer('MAX_QUEUED_REQUESTS', 10, 0, 100),
    cooldownMs: integer('USER_COOLDOWN_SECONDS', 10, 0, 3600) * 1000,
    retryCount: integer('API_RETRIES', 2, 0, 3),
  };
}
export type Config = ReturnType<typeof loadConfig>;
