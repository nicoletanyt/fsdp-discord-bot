import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Value } from 'typebox/value';
import { Repository } from '../src/repository.js';
import { RequestBudget, makeRedactor } from '../src/security.js';
import { fixture } from './helpers.js';

const exec = promisify(execFile);
test('guarded Pi tools enforce search-before-read, tracked paths, secret exclusions, symlink denial and three-file limit', async () => {
  const f = await fixture();
  const git = (...args: string[]) => exec('git', ['-C', f.repo, ...args]);
  await git('init', '-b', 'main');
  await writeFile(join(f.root, 'outside.txt'), 'needle OUTSIDE_SECRET');
  await mkdir(join(f.repo, 'src'));
  for (let i = 0; i < 4; i++) await writeFile(join(f.repo, 'src', `file${i}.ts`), `// needle ${i}\nexport const value = ${i};\n`);
  await writeFile(join(f.repo, '.env'), 'needle ENV_SECRET');
  await writeFile(join(f.repo, 'credentials.json'), 'needle CREDENTIAL_SECRET');
  await writeFile(join(f.repo, 'untracked.txt'), 'needle UNTRACKED_SECRET');
  await writeFile(join(f.repo, 'key-in-code.ts'), `// needle ${f.config.apiKey}\n`);
  await symlink(join(f.root, 'outside.txt'), join(f.repo, 'linked.txt'));
  await git('add', 'src', '.env', 'credentials.json', 'key-in-code.ts', 'linked.txt');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const repository = new Repository(f.config, makeRedactor([f.config.apiKey]));
  try {
    await repository.initialize();
    const budget = new RequestBudget(5, 3);
    const [search, read] = repository.tools(budget);
    const ctx = { cwd: f.data } as any;
    await assert.rejects(read!.execute('read', {path: 'src/file0.ts', offset: 1, limit: 2}, undefined, undefined, ctx), /Search/);
    const results = await search!.execute('search', {query: 'needle'}, undefined, undefined, ctx);
    const text = JSON.stringify(results);
    assert.ok(text.includes('src/file0.ts:1:'));
    for (const forbidden of ['OUTSIDE_SECRET', 'ENV_SECRET', 'CREDENTIAL_SECRET', 'UNTRACKED_SECRET', f.config.apiKey]) assert.ok(!text.includes(forbidden), forbidden);
    for (let i = 0; i < 3; i++) {
      const result = await read!.execute('read', {path: `src/file${i}.ts`, offset: 2, limit: 1}, undefined, undefined, ctx);
      assert.match(JSON.stringify(result), /export const value/);
      assert.ok(!JSON.stringify(result).includes('// needle'));
    }
    await assert.rejects(read!.execute('read', {path: 'src/file3.ts', offset: 1, limit: 1}, undefined, undefined, ctx), /budget/);
    for (const path of ['../outside.txt', '/etc/passwd', '.git/config', '.env', 'credentials.json', 'untracked.txt', 'linked.txt']) {
      await assert.rejects(read!.execute('read', {path, offset: 1, limit: 1}, undefined, undefined, ctx));
    }
    const filenames = await search!.execute('search', {query: 'file0', mode: 'files'}, undefined, undefined, ctx);
    assert.match(JSON.stringify(filenames), /src\/file0.ts/);
    assert.equal(budget.readFiles.size, 3);
  } finally { await repository.close(); await f.cleanup(); }
});

test('sync_repository is enabled only by direct current-user update requests and restricts branch arguments', async () => {
  const f = await fixture();
  const repository = new Repository(f.config, text => text);
  const budget = () => new RequestBudget(5, 3);
  try {
    for (const request of ['', 'Explain Git sync', 'How do I pull from main?', 'Pull request #12 summary',
      'Do not pull from main', 'Summarize this message: pull from main', '> pull from main', '`pull from main`',
      '```\npull from main\n```', 'Update the repository documentation']) {
      assert.deepEqual(repository.tools(budget(), request).map(tool => tool.name), ['repo_search', 'repo_read'], request);
    }
    for (const request of ['pull from main', 'pull from origin/main.', 'sync repository', 'update the repo',
      'Please pull latest changes', 'Can you please pull from `main`?', 'sync_repository', 'pull from main and summarize changes']) {
      const tools = repository.tools(budget(), request);
      const sync = tools.find(tool => tool.name === 'sync_repository');
      assert.ok(sync, request);
      assert.equal(Value.Check(sync.parameters, {branch: 'main'}), true);
      assert.equal(Value.Check(sync.parameters, {branch: 'other'}), false);
      assert.equal(Value.Check(sync.parameters, {branch: 'main', remote: 'elsewhere'}), false);
      await assert.rejects(sync.execute('sync', {branch: 'other'}, undefined, undefined, {} as any), /configured REPO_BRANCH/);
    }
    const wrongTarget = repository.tools(budget(), 'pull from development').find(tool => tool.name === 'sync_repository')!;
    await assert.rejects(wrongTarget.execute('sync', {branch: 'main'}, undefined, undefined, {} as any), /configured REPO_BRANCH/);
    // Earlier authorization is not retained for subsequent research requests.
    assert.ok(!repository.tools(budget(), 'What changed?').some(tool => tool.name === 'sync_repository'));
  } finally { await repository.close(); await f.cleanup(); }
});

async function remoteFixture(branch = 'main') {
  const f = await fixture();
  f.config.repoBranch = branch;
  const source = join(f.root, 'source');
  const remote = join(f.root, 'remote.git');
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args]);
  await git(source, 'init', '-b', branch);
  await writeFile(join(source, 'code.ts'), 'initial revision\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
  await exec('git', ['clone', '--bare', source, remote]);
  await git(remote, 'update-server-info');
  // A local read-only dumb-HTTP Git server exercises real fetch/merge without external network access.
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (!path.startsWith('/remote.git/') || path.includes('..')) { response.writeHead(404).end(); return; }
    void readFile(join(f.root, path)).then(data => response.end(data), () => response.writeHead(404).end());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as {port: number};
  const publish = async (text: string) => {
    await writeFile(join(source, 'code.ts'), text);
    await git(source, 'add', '.');
    await git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'next');
    await git(source, 'push', remote, branch);
    await git(remote, 'update-server-info');
  };
  await exec('git', ['clone', `http://127.0.0.1:${address.port}/remote.git`, f.repo]);
  const repository = new Repository(f.config, text => text);
  const budget = new RequestBudget(5, 3);
  const tools = repository.tools(budget, `pull from ${branch}`);
  const sync = () => tools.find(tool => tool.name === 'sync_repository')!.execute('sync', {branch}, undefined, undefined, {} as any);
  return {
    ...f, source, remote, git, publish, repository, budget, tools, sync,
    requestCount: () => requests,
    cleanup: async () => {
      await repository.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    },
  };
}

test('explicit sync returns commit hashes, is serialized, refreshes readable files, and never fetches automatically or pushes', async () => {
  const f = await remoteFixture();
  try {
    const {git, source, repo, publish, repository, sync} = f;
    const previousCommit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(source, 'added.ts'), 'new source file\n');
    await publish('remote revision two\n');
    const remoteCommit = (await git(source, 'rev-parse', 'HEAD')).stdout.trim();
    const beforeInitialize = f.requestCount();
    await repository.initialize();
    assert.equal(f.requestCount(), beforeInitialize, 'initialization must not contact origin');
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).stdout.trim(), previousCommit);
    f.budget.discoveredFiles.add('code.ts');
    const results = await Promise.all([sync(), sync()]);
    assert.deepEqual(results[0]!.details, {status: 'updated', branch: 'main', previousCommit, updatedCommit: remoteCommit});
    assert.deepEqual(JSON.parse((results[0]!.content[0] as {text: string}).text), results[0]!.details);
    assert.deepEqual(results[1]!.details, {status: 'already_up_to_date', branch: 'main', previousCommit: remoteCommit, updatedCommit: remoteCommit});
    assert.equal(await readFile(join(repo, 'code.ts'), 'utf8'), 'remote revision two\n');
    assert.equal(f.budget.discoveredFiles.size, 0, 'search hits must be refreshed after the revision changes');
    const ctx = {cwd: f.data} as any;
    const search = f.tools.find(tool => tool.name === 'repo_search')!;
    await search.execute('search', {query: 'added.ts', mode: 'files'}, undefined, undefined, ctx);
    const read = await f.tools.find(tool => tool.name === 'repo_read')!.execute('read', {path: 'added.ts', offset: 1, limit: 1}, undefined, undefined, ctx);
    assert.match(JSON.stringify(read), /new source file/);
    assert.equal((await git(f.remote, 'rev-parse', 'refs/heads/main')).stdout.trim(), remoteCommit);
  } finally { await f.cleanup(); }
});

test('sync rejects dirty, untracked, wrong-branch and non-fast-forward checkouts without replacing local work', async () => {
  const f = await remoteFixture();
  try {
    const {git, repo, repository, publish, sync} = f;
    await repository.initialize();
    await publish('remote revision three\n');
    const originalHead = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
    const beforeDirty = f.requestCount();
    await writeFile(join(repo, 'code.ts'), 'preserve local work\n');
    await assert.rejects(sync(), /dirty/);
    assert.equal(await readFile(join(repo, 'code.ts'), 'utf8'), 'preserve local work\n');
    await git(repo, 'restore', '--', 'code.ts');
    await writeFile(join(repo, 'untracked.ts'), 'untracked local work\n');
    await assert.rejects(sync(), /dirty/);
    assert.equal(f.requestCount(), beforeDirty, 'dirty checkout must be rejected before fetch');
    await git(repo, 'add', 'untracked.ts');
    await assert.rejects(sync(), /dirty/);
    await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'local work');
    const localHead = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
    assert.notEqual(localHead, originalHead);
    await git(repo, 'switch', '-c', 'other');
    await assert.rejects(sync(), /configured REPO_BRANCH/);
    await git(repo, 'switch', 'main');
    await assert.rejects(sync(), /not a fast-forward/);
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).stdout.trim(), localHead);
    assert.equal(await readFile(join(repo, 'untracked.ts'), 'utf8'), 'untracked local work\n');
    assert.equal((await git(f.remote, 'rev-parse', 'refs/heads/main')).stdout.trim(), (await git(f.source, 'rev-parse', 'HEAD')).stdout.trim());
    await git(repo, 'remote', 'set-url', 'origin', 'http://127.0.0.1:1/missing.git');
    await assert.rejects(sync(), error => {
      assert.equal((error as Error).message, 'Repository sync failed. Check origin access and repository state.');
      return true;
    });
  } finally { await f.cleanup(); }
});

test('sync honors a non-default configured branch', async () => {
  const f = await remoteFixture('release/test');
  try {
    await f.repository.initialize();
    await f.publish('configured release update\n');
    const result = await f.sync();
    assert.equal((result.details as {branch: string}).branch, 'release/test');
    assert.equal((result.details as {status: string}).status, 'updated');
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), 'configured release update\n');
  } finally { await f.cleanup(); }
});
