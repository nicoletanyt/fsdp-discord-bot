// Error bodies may contain prompts, URLs, headers or credentials. Only fixed categories,
// allowlisted provider reasons and numeric status codes may leave this classifier.
const PROVIDER_REASONS = [
  'API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED', 'SERVICE_DISABLED', 'CONSUMER_INVALID', 'QUOTA_EXCEEDED',
  'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'INVALID_ARGUMENT', 'NOT_FOUND', 'DEADLINE_EXCEEDED', 'UNAVAILABLE', 'INTERNAL',
] as const;

export interface SafeFailure {
  category: 'authentication' | 'permission' | 'quota' | 'rate_limit' | 'invalid_request'
    | 'not_found' | 'timeout' | 'network' | 'provider_unavailable' | 'output_blocked'
    | 'incomplete_stream' | 'empty_response' | 'sdk_error' | 'storage' | 'unknown';
  httpStatus?: number;
  providerReason?: typeof PROVIDER_REASONS[number];
  errorType?: 'Error' | 'TypeError' | 'ReferenceError' | 'SyntaxError' | 'AbortError';
  networkCode?: 'ENOTFOUND' | 'EAI_AGAIN' | 'ECONNRESET' | 'ECONNREFUSED' | 'ETIMEDOUT' | 'UND_ERR_CONNECT_TIMEOUT';
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function safeFailure(error: unknown): SafeFailure {
  const source = object(error);
  const text = (typeof error === 'string' ? error
    : typeof source.errorMessage === 'string' ? source.errorMessage
      : typeof source.message === 'string' ? source.message : '').slice(0, 16000);
  let body: Record<string, unknown> = {};
  try { const parsed = object(JSON.parse(text)); body = object(parsed.error ?? parsed); } catch { /* Not JSON. */ }
  const candidates = [source.status, source.statusCode, object(source.response).status, body.code,
    /(?:^\s*|\b(?:status|statusCode|code)["':\s]+)([45]\d{2})\b/.exec(text)?.[1]];
  const httpStatus = candidates.map(Number).find(code => Number.isInteger(code) && code >= 400 && code <= 599);
  const providerReason = PROVIDER_REASONS.find(reason => new RegExp(`\\b${reason}\\b`).test(text));
  const errorType = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'AbortError'].includes(String(source.name))
    ? source.name as SafeFailure['errorType'] : undefined;
  const code = source.code ?? object(source.cause).code;
  const networkCode = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code))
    ? code as SafeFailure['networkCode'] : undefined;
  let category: SafeFailure['category'] = 'unknown';
  if (/api.?key.*(?:invalid|expired|not valid|required)|(?:no|missing|invalid) api.?key|API_KEY_|unauthenticated|not configured|authentication/i.test(text) || httpStatus === 401) category = 'authentication';
  else if (/quota|billing|RESOURCE_EXHAUSTED/i.test(text)) category = 'quota';
  else if (httpStatus === 429 || /rate.?limit/i.test(text)) category = 'rate_limit';
  else if (httpStatus === 403 || /permission.denied|SERVICE_DISABLED/i.test(text)) category = 'permission';
  else if (httpStatus === 404 || providerReason === 'NOT_FOUND') category = 'not_found';
  else if (httpStatus === 400 || providerReason === 'INVALID_ARGUMENT') category = 'invalid_request';
  else if (httpStatus === 408 || httpStatus === 504 || /timeout|timed out|DEADLINE_EXCEEDED/i.test(text)) category = 'timeout';
  else if (networkCode || /fetch failed|network|ECONN|ENOTFOUND/i.test(text)) category = 'network';
  else if (httpStatus && httpStatus >= 500) category = 'provider_unavailable';
  else if (/SAFETY|BLOCKLIST|PROHIBITED_CONTENT|RECITATION/i.test(text)) category = 'output_blocked';
  else if (/stream ended without.*finish reason/i.test(text)) category = 'incomplete_stream';
  else if (text === 'No answer received') category = 'empty_response';
  else if (source.code === 'ERR_SQLITE_ERROR') category = 'storage';
  else if (errorType === 'TypeError' || errorType === 'ReferenceError' || errorType === 'SyntaxError'
    || /custom fetch is not supported|unsupported.*thinking|is not a function|cannot read properties/i.test(text)) category = 'sdk_error';
  return { category, ...(httpStatus !== undefined && { httpStatus }), ...(providerReason && { providerReason }),
    ...(errorType && { errorType }), ...(networkCode && { networkCode }) };
}

export type LimitName = 'model_calls' | 'tool_calls' | 'context_bytes' | 'repository_files' | 'repository_file_bytes' | 'discord_results' | 'discord_bytes';
export type ModelOutcome = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'unknown';
export function modelOutcome(reason: string): ModelOutcome {
  return ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(reason) ? reason as ModelOutcome : 'unknown';
}

export interface Diagnostic {
  event: 'model_call_started' | 'model_call_finished' | 'request_timeout' | 'limit_reached' | 'limit_exceeded' | 'request_finished';
  requestId: string;
  provider: string;
  model: string;
  modelCallCount: number;
  durationMs: number;
  outcome?: ModelOutcome | 'success' | 'timeout' | 'enforced_limit';
  failure?: SafeFailure;
  limit?: LimitName;
  actual?: number;
  maximum?: number;
  toolCalls?: number;
  repositoryFiles?: number;
  discordResults?: number;
  discordBytes?: number;
}

export function logDiagnostic(entry: Diagnostic) {
  const line = JSON.stringify(entry);
  if (entry.event === 'request_timeout' || entry.event === 'limit_exceeded' || entry.failure) console.warn(line);
  else console.info(line);
}
