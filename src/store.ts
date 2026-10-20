import { DatabaseSync } from 'node:sqlite';
import type { Usage } from '@earendil-works/pi-ai';

export interface StoredMessage {
  id: string; guild_id: string; channel_id: string; parent_id: string | null;
  author: string; content: string; timestamp: number;
}
export const messageLink = (message: StoredMessage) => `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, parent_id TEXT,
        author TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_scope_time ON messages(guild_id, channel_id, timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, model TEXT NOT NULL, timestamp INTEGER NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_scope ON usage(scope);
    `);
  }
  upsert(message: StoredMessage) {
    this.db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content, author=excluded.author`)
      .run(message.id, message.guild_id, message.channel_id, message.parent_id, message.author, message.content, message.timestamp);
  }
  delete(id: string) { this.db.prepare('DELETE FROM messages WHERE id=?').run(id); }
  scopes(guild: string, limit = 100): string[] {
    return (this.db.prepare('SELECT channel_id FROM messages WHERE guild_id=? GROUP BY channel_id ORDER BY max(timestamp) DESC LIMIT ?')
      .all(guild, limit) as {channel_id: string}[]).map(row => row.channel_id);
  }
  search(guild: string, channels: string[], query: string, limit: number): StoredMessage[] {
    const words = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12);
    if (!words?.length || !channels.length) return [];
    const expression = words.map(word => `"${word}"`).join(' OR ');
    return this.db.prepare(`SELECT m.id, m.guild_id, m.channel_id, m.parent_id, m.author, m.timestamp,
      snippet(messages_fts, 0, '', '', ' … ', 48) AS content FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.guild_id=? AND m.channel_id IN (${channels.map(() => '?').join(',')})
      ORDER BY bm25(messages_fts), m.timestamp DESC LIMIT ?`)
      .all(expression, guild, ...channels, Math.min(10, limit)) as unknown as StoredMessage[];
  }
  around(guild: string, channels: string[], anchor: string, limit: number): StoredMessage[] {
    const message = this.db.prepare('SELECT * FROM messages WHERE id=? AND guild_id=?').get(anchor, guild) as unknown as StoredMessage | undefined;
    if (!message || !channels.includes(message.channel_id)) return [];
    return this.db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE guild_id=? AND channel_id=?
      ORDER BY abs(timestamp-?) LIMIT ?) ORDER BY timestamp`)
      .all(guild, message.channel_id, message.timestamp, Math.min(10, limit)) as unknown as StoredMessage[];
  }
  recordUsage(scope: string, model: string, usage: Usage) {
    this.db.prepare('INSERT INTO usage(scope,model,timestamp,input,output,cache_read,cache_write,cost) VALUES (?,?,?,?,?,?,?,?)')
      .run(scope, model, Date.now(), usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total);
  }
  usage(scope: string) {
    return this.db.prepare(`SELECT count(*) AS calls, coalesce(sum(input),0) AS input, coalesce(sum(output),0) AS output,
      coalesce(sum(cache_read),0) AS cache_read, coalesce(sum(cache_write),0) AS cache_write, coalesce(sum(cost),0) AS cost
      FROM usage WHERE scope=?`).get(scope) as {calls: number; input: number; output: number; cache_read: number; cache_write: number; cost: number};
  }
  close() { this.db.close(); }
}
