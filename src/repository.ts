import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { Type } from 'typebox';
import { createGrepToolDefinition, createReadToolDefinition, defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.js';
import { clip, RequestBudget, secretPath } from './security.js';
import { Mutex, withAbort } from './concurrency.js';

const execute = promisify(execFile);
const EXCLUDE = '!{.git/**,**/.git/**,.pi/**,**/.pi/**,.env*,**/.env*,node_modules/**,**/node_modules/**,**/*secret*,**/*credential*,**/*.pem,**/*.key,**/*.p12,**/*.pfx,.npmrc,**/.npmrc,.netrc,**/.netrc}';

class RepositorySyncError extends Error {}

// Only a direct command in the current Discord request enables the mutating tool.
// Questions about Git, quoted commands and retrieved instructions do not authorize it.
function requestedSyncBranch(request: string, configuredBranch: string): string | undefined {
  const command = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:pull(?:\s+(?:the\s+)?(?:latest(?:\s+changes)?|changes))?|(?:sync|synchronize|update)\s+(?:the\s+)?(?:repo(?:sitory)?|checkout)|sync_repository)(?:\s+from\s+`?([^\s`?!,;]+)`?)?(?=\s*(?:$|[?!.,;]|\band\b|\bthen\b))/i.exec(request.trim());
  return command ? command[1]?.replace(/^origin\//, '').replace(/\.$/, '') ?? configuredBranch : undefined;
}

export class Repository {
  private root = '';
  private tracked = new Set<string>();
  private lock = new Mutex();
  constructor(private config: Config, private redact: (text: string) => string) {}
  private async git(args: string[], signal?: AbortSignal) {
    const { stdout } = await execute('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never',
      '-C', this.root, ...args,
    ], {
      timeout: 60000, maxBuffer: 16 * 1024 * 1024, signal,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }
  async initialize() {
    await execute('rg', ['--version'], { timeout: 5000 });
    this.root = await realpath(this.config.repoPath);
    const top = await this.git(['rev-parse', '--show-toplevel']);
    if (await realpath(top.trim()) !== this.root) throw new Error('REPO_PATH must be the checkout root');
    await this.git(['check-ref-format', '--branch', this.config.repoBranch]);
    const branch = (await this.git(['branch', '--show-current'])).trim();
    if (branch !== this.config.repoBranch) throw new Error('Checkout branch must match REPO_BRANCH');
    await this.refreshFiles();
  }
  private async refreshFiles() {
    const files = await this.git(['ls-files', '-z', '--cached']);
    this.tracked = new Set(files.split('\0').filter(path => path && !secretPath(path) && !/[\n\r:]/.test(path)));
  }
  private async requireCleanBranch(signal?: AbortSignal) {
    const branch = (await this.git(['branch', '--show-current'], signal)).trim();
    if (branch !== this.config.repoBranch) throw new RepositorySyncError('Sync rejected: checkout must be on the configured REPO_BRANCH.');
    if ((await this.git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], signal)).trim()) {
      throw new RepositorySyncError('Sync rejected: working tree is dirty (including untracked files).');
    }
  }
  private synchronize(branch: string, signal?: AbortSignal) {
    return this.lock.run(async () => {
      try {
        signal?.throwIfAborted();
        if (branch !== this.config.repoBranch) throw new RepositorySyncError('Sync rejected: only the configured REPO_BRANCH is allowed.');
        await this.requireCleanBranch(signal);
        const previousCommit = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
        await this.git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${branch}`], signal);
        const targetCommit = (await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], signal)).trim();
        // Refuse external branch, HEAD or working-tree changes during the fetch as well.
        await this.requireCleanBranch(signal);
        if ((await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim() !== previousCommit) {
          throw new RepositorySyncError('Sync rejected: checkout changed during fetch.');
        }
        if (previousCommit === targetCommit) {
          return { status: 'already_up_to_date' as const, branch, previousCommit, updatedCommit: previousCommit };
        }
        try {
          await this.git(['merge-base', '--is-ancestor', previousCommit, targetCommit], signal);
        } catch (error) {
          if ((error as { code?: unknown }).code === 1) {
            throw new RepositorySyncError('Sync rejected: update is not a fast-forward.');
          }
          throw error;
        }
        await this.git(['merge', '--ff-only', '--no-edit', '--no-autostash', targetCommit], signal);
        const updatedCommit = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
        await this.refreshFiles();
        return { status: 'updated' as const, branch, previousCommit, updatedCommit };
      } catch (error) {
        if (error instanceof RepositorySyncError) throw error;
        throw new Error('Repository sync failed. Check origin access and repository state.');
      }
    });
  }
  private async safeFile(path: string) {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (isAbsolute(rel) || rel.startsWith('..') || !this.tracked.has(rel) || secretPath(rel)) throw new Error('File access denied');
    // Reject symlinks, including intermediate directories and links pointing inside the repository.
    if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile()) throw new Error('File access denied');
    return { absolute, rel };
  }
  private async readSafe(path: string): Promise<Buffer> {
    const { absolute } = await this.safeFile(path);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.config.maxFileBytes) throw new Error('File exceeds size limit');
      const buffer = Buffer.alloc(Math.min(stat.size + 1, this.config.maxFileBytes + 1));
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > this.config.maxFileBytes) throw new Error('File exceeds size limit');
      const content = buffer.subarray(0, size);
      if (content.includes(0)) throw new Error('Binary files are not available');
      return Buffer.from(this.redact(content.toString('utf8')));
    } finally { await file.close(); }
  }
  tools(budget: RequestBudget, request = '') {
    const grep = createGrepToolDefinition(this.root);
    const read = createReadToolDefinition(this.root, { operations: {
      access: async path => { await this.safeFile(path); }, readFile: path => this.readSafe(path),
      detectImageMimeType: async () => undefined,
    } });
    const tools: ToolDefinition[] = [
      defineTool({
        name: 'repo_search', label: 'Repository search',
        annotations: { readOnlyHint: true },
        description: 'Search repository text with a literal keyword or phrase, or search filenames with mode=files. Returns bounded matches. Search before repo_read.',
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('files')])) }),
        execute: async (id, { query, mode }, signal, _update, ctx) => withAbort(this.lock.run(async () => {
          signal?.throwIfAborted();
          try {
            if (mode === 'files') {
              const paths: string[] = [];
              for (const path of this.tracked) {
                if (!path.toLowerCase().includes(query.toLowerCase())) continue;
                try {
                  await this.safeFile(path);
                  if (paths.length >= 30 || Buffer.byteLength([...paths, path].join('\n')) > this.config.toolResultBytes) break;
                  paths.push(path); budget.discoveredFiles.add(path);
                } catch { /* Do not expose inaccessible paths. */ }
              }
              return { content: [{ type: 'text', text: paths.join('\n') || 'No accessible filenames matched.' }], details: {} };
            }
            const result = await grep.execute(id, { pattern: query, path: this.root, glob: EXCLUDE, literal: true, ignoreCase: true, context: 0, limit: 40 }, signal, undefined, ctx);
            const lines: string[] = [];
            for (const block of result.content) {
              if (block.type !== 'text') continue;
              for (const line of block.text.split('\n')) {
                const match = /^(.+?):(\d+):/.exec(line);
                if (!match?.[1]) continue;
                try {
                  const file = await this.safeFile(match[1]);
                  const safe = this.redact(line);
                  if (Buffer.byteLength(lines.join('\n') + '\n' + safe) > this.config.toolResultBytes) break;
                  budget.discoveredFiles.add(file.rel); lines.push(safe);
                } catch { /* Untracked, sensitive or symlinked paths never reach the model. */ }
              }
            }
            return { content: [{ type: 'text', text: lines.join('\n') || 'No accessible matches. Try a more specific keyword.' }], details: {} };
          } catch { throw new Error('Repository search failed'); }
        }), signal),
      }),
      defineTool({
        name: 'repo_read', label: 'Repository section',
        annotations: { readOnlyHint: true },
        description: `Read a relevant section of a file found by repo_search; at most ${this.config.maxRepoFiles} distinct files per request.`,
        parameters: Type.Object({ path: Type.String({ maxLength: 500 }), offset: Type.Integer({ minimum: 1 }), limit: Type.Integer({ minimum: 1, maximum: this.config.maxReadLines }) }),
        execute: async (id, input, signal, _update, ctx) => withAbort(this.lock.run(async () => {
          signal?.throwIfAborted();
          const file = await this.safeFile(input.path);
          budget.claimRead(file.rel);
          const result = await read.execute(id, { ...input, path: file.absolute }, signal, undefined, ctx);
          const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          return { content: [{ type: 'text', text: clip(`${file.rel}:${input.offset}\n${this.redact(text)}`, this.config.toolResultBytes) }], details: {} };
        }), signal),
      }),
    ];
    const requestedBranch = requestedSyncBranch(request, this.config.repoBranch);
    if (requestedBranch !== undefined) tools.push(defineTool({
      name: 'sync_repository', label: 'Sync repository',
      description: `Fetch origin/${this.config.repoBranch} and fast-forward the configured local checkout only when the current user explicitly requests a repository update. Rejects dirty trees, other branches and non-fast-forward updates. Never pushes. Returns previousCommit and updatedCommit, or status=already_up_to_date.`,
      annotations: { readOnlyHint: false },
      parameters: Type.Object({ branch: Type.Literal(this.config.repoBranch) }, { additionalProperties: false }),
      execute: async (_id, { branch }, signal) => {
        if (requestedBranch !== this.config.repoBranch || branch !== this.config.repoBranch) {
          throw new Error('Sync rejected: only the configured REPO_BRANCH is allowed.');
        }
        const result = await withAbort(this.synchronize(branch, signal), signal);
        if (result.status === 'updated') budget.discoveredFiles.clear();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    }));
    return tools;
  }
  async close() { await this.lock.run(async () => {}); }
}
