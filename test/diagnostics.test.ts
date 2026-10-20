import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime, defineTool } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { ResearchAgent } from '../src/agent.js';
import { Repository } from '../src/repository.js';
import { History } from '../src/history.js';
import { RequestBudget } from '../src/security.js';
import { Store } from '../src/store.js';
import { safeFailure } from '../src/diagnostics.js';
import { fixture } from './helpers.js';

function captureLogs(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => { lines.push(line); });
  t.mock.method(console, 'warn', (line: string) => { lines.push(line); });
  return { records: () => lines.map(line => JSON.parse(line)), text: () => lines.join('\n') };
}

function googleResponse(text: string) {
  return new Response(`data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('real Pi runtime and Google adapter send a bounded authenticated request and complete without exposing contents', async t => {
  const f = await fixture();
  const store = new Store(':memory:');
  const agent = new ResearchAgent(f.config, store, text => text);
  const logs = captureLogs(t);
  let requests = 0;
  // Mock only HTTP: the Pi session, auth resolution, Google adapter and Google SDK remain real.
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, 'https://generativelanguage.googleapis.com');
    assert.equal(new URL(request.url).pathname, '/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    assert.equal(request.headers.get('x-goog-api-key'), f.config.apiKey);
    const body = await request.json();
    assert.equal(body.generationConfig.maxOutputTokens, f.config.maxOutputTokens);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.deepEqual(body.tools[0].functionDeclarations.map((tool: {name: string}) => tool.name),
      ['repo_search', 'repo_read', 'discord_search', 'discord_context']);
    return googleResponse('PRIVATE_ANSWER_MARKER');
  });
  try {
    await agent.initialize();
    const budget = new RequestBudget(5, 3);
    const tools = [...new Repository(f.config, text => text).tools(budget),
      ...new History({} as any, f.config, store, text => text).tools(budget, {} as any)];
    const answer = await agent.answer(`${f.config.guildId}-222222222222222222`, 'What is C++? PRIVATE_PROMPT_MARKER', budget, tools);
    assert.equal(answer, 'PRIVATE_ANSWER_MARKER');
    assert.equal(requests, 1);
    const events = logs.records();
    assert.deepEqual(events.map(event => event.event), ['model_call_started', 'model_call_finished', 'request_finished']);
    assert.equal(events[1].modelCallCount, 1);
    assert.equal(events[1].outcome, 'stop');
    assert.equal(events[2].modelCallCount, 1);
    assert.equal(events[2].toolCalls, 0);
    assert.equal(events[2].outcome, 'success');
    assert.ok(events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0));
    assert.equal(new Set(events.map(event => event.requestId)).size, 1);
    for (const secret of [f.config.apiKey, 'PRIVATE_PROMPT_MARKER', 'PRIVATE_ANSWER_MARKER', 'What is C++?']) {
      assert.ok(!logs.text().includes(secret));
    }
  } finally { await agent.close(); store.close(); await f.cleanup(); }
});

test('Google HTTP errors expose only status, allowlisted reason, timing and count, never raw error bodies', async t => {
  const f = await fixture();
  const store = new Store(':memory:');
  const agent = new ResearchAgent(f.config, store, text => text);
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: {
    code: 400, status: 'INVALID_ARGUMENT',
    message: `API key not valid. ${f.config.apiKey} PRIVATE_PROVIDER_BODY PRIVATE_PROMPT_MARKER`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
  } }), {status: 400, headers: {'Content-Type': 'application/json'}}));
  try {
    await agent.initialize();
    await assert.rejects(agent.answer(`${f.config.guildId}-222222222222222222`, 'PRIVATE_PROMPT_MARKER', new RequestBudget(5, 3), []), /AI request failed/);
    const finished = logs.records().find(event => event.event === 'model_call_finished');
    assert.equal(finished.outcome, 'error');
    assert.equal(finished.modelCallCount, 1);
    assert.deepEqual(finished.failure, {category: 'authentication', httpStatus: 400, providerReason: 'API_KEY_INVALID'});
    const request = logs.records().find(event => event.event === 'request_finished');
    assert.deepEqual(request.failure, finished.failure);
    assert.equal(request.outcome, 'error');
    assert.ok(!request.limit, 'provider failure must not be mislabeled as an enforced limit');
    for (const secret of [f.config.apiKey, 'PRIVATE_PROVIDER_BODY', 'PRIVATE_PROMPT_MARKER', 'API key not valid.']) {
      assert.ok(!logs.text().includes(secret));
    }
  } finally { await agent.close(); store.close(); await f.cleanup(); }
});

test('timeouts record one aborted model duration and the current count without logging error text', async t => {
  const f = await fixture();
  f.config.requestTimeoutMs = 25;
  const store = new Store(':memory:');
  const agent = new ResearchAgent(f.config, store, text => text);
  const logs = captureLogs(t);
  t.mock.method(ModelRuntime.prototype, 'streamSimple', (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options!.signal!.addEventListener('abort', () => {
      const error: AssistantMessage = {
        role: 'assistant', content: [], api: 'google-generative-ai', provider: 'google', model: f.config.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0} },
        stopReason: 'aborted', timestamp: Date.now(), errorMessage: `PRIVATE_ABORT_BODY ${f.config.apiKey}`,
      };
      stream.push({type: 'error', reason: 'aborted', error});
    }, {once: true});
    return stream;
  });
  try {
    await agent.initialize();
    await assert.rejects(agent.answer(`${f.config.guildId}-222222222222222222`, 'PRIVATE_PROMPT_MARKER', new RequestBudget(5, 3), []), /timed out/);
    const records = logs.records();
    assert.equal(records.filter(event => event.event === 'model_call_finished').length, 1);
    const call = records.find(event => event.event === 'model_call_finished');
    assert.equal(call.outcome, 'aborted');
    assert.ok(call.durationMs >= 20);
    const timeout = records.find(event => event.event === 'request_timeout');
    assert.equal(timeout.modelCallCount, 1);
    assert.equal(timeout.maximum, 25);
    assert.equal(records.at(-1).outcome, 'timeout');
    assert.ok(!logs.text().includes('PRIVATE_'));
    assert.ok(!logs.text().includes(f.config.apiKey));
  } finally { await agent.close(); store.close(); await f.cleanup(); }
});

test('context limit diagnostics report zero provider calls and only numeric sizes', async t => {
  const f = await fixture();
  f.config.contextBytes = 16000;
  const store = new Store(':memory:');
  const agent = new ResearchAgent(f.config, store, text => text);
  const logs = captureLogs(t);
  const runtime = t.mock.method(ModelRuntime.prototype, 'streamSimple', () => { assert.fail('Provider must not be called'); });
  const tool = defineTool({name: 'oversized', label: 'oversized', description: 'PRIVATE_TOOL_CONTENT'.repeat(1500),
    parameters: Type.Object({}), execute: async () => ({content: [{type: 'text', text: 'unused'}], details: {}}),
  });
  try {
    await agent.initialize();
    await assert.rejects(agent.answer(`${f.config.guildId}-222222222222222222`, 'PRIVATE_PROMPT_MARKER', new RequestBudget(5, 3), [tool]));
    assert.equal(runtime.mock.callCount(), 0);
    const limit = logs.records().find(event => event.event === 'limit_exceeded');
    assert.equal(limit.limit, 'context_bytes');
    assert.equal(limit.maximum, 16000);
    assert.ok(limit.actual > limit.maximum);
    assert.equal(limit.modelCallCount, 0);
    assert.equal(logs.records().at(-1).outcome, 'enforced_limit');
    assert.ok(!logs.text().includes('PRIVATE_'));
  } finally { await agent.close(); store.close(); await f.cleanup(); }
});

test('safe error classification preserves useful causes but excludes arbitrary strings and nested request data', () => {
  const secret = 'PRIVATE_SECRET_AND_MESSAGE_CONTENT';
  const cases = [
    [{message: `429: quota exceeded ${secret}`}, 'quota', 429],
    [{status: 429, message: `rate limit ${secret}`}, 'rate_limit', 429],
    [{message: JSON.stringify({error: {code: 404, status: 'NOT_FOUND', message: secret}})}, 'not_found', 404],
    [{status: 403, message: `SERVICE_DISABLED ${secret}`}, 'permission', 403],
    [{status: 503, message: secret}, 'provider_unavailable', 503],
    [{cause: {code: 'ENOTFOUND'}, message: secret}, 'network', undefined],
    [new TypeError(secret), 'sdk_error', undefined],
    [{errorMessage: 'Google stream ended without a finish reason'}, 'incomplete_stream', undefined],
    [{message: secret, name: secret, code: secret, request: {headers: {authorization: secret}}}, 'unknown', undefined],
  ] as const;
  for (const [error, category, status] of cases) {
    const diagnostic = safeFailure(error);
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.httpStatus, status);
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
});
