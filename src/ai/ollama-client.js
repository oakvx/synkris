/**
 * Private, bounded Ollama HTTP adapter. No network calls unless AI_ENABLED=1.
 * Callers never receive the raw HTTP response or headers.
 */
const DEFAULT_BASE = 'http://127.0.0.1:11434';

export function isAIEnabled(env = process.env) {
  return env.AI_ENABLED === '1';
}

export function resolveOllamaBase(env = process.env) {
  const raw = String(env.OLLAMA_URL || DEFAULT_BASE).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid OLLAMA_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Unsafe OLLAMA_URL');
  }
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]', 'ollama'].includes(url.hostname.toLowerCase());
  if (!local && env.OLLAMA_ALLOW_REMOTE !== '1') throw new Error('Remote Ollama disabled');
  if (!local && url.protocol !== 'https:') throw new Error('Remote Ollama requires HTTPS');
  return url.origin;
}

export class OllamaUnavailableError extends Error {
  constructor(code) {
    super(`Ollama unavailable: ${code}`);
    this.name = 'OllamaUnavailableError';
    this.code = code;
  }
}

export async function postOllama(endpoint, payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  if (!isAIEnabled(env)) return null;
  if (!['/api/chat', '/api/generate'].includes(endpoint)) throw new Error('Invalid Ollama endpoint');
  const base = resolveOllamaBase(env);
  const duration = Math.min(30000, Math.max(500, Number(timeoutMs) || 4000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    const response = await fetchImpl(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new OllamaUnavailableError(`http_${response.status}`);
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (contentLength > 128_000) throw new OllamaUnavailableError('response_too_large');
    const body = await response.text();
    if (body.length > 128_000) throw new OllamaUnavailableError('response_too_large');
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') throw new OllamaUnavailableError('invalid_response');
    return parsed;
  } catch (error) {
    if (error instanceof OllamaUnavailableError) throw error;
    if (error.name === 'AbortError') throw new OllamaUnavailableError('timeout');
    throw new OllamaUnavailableError('connection_or_protocol');
  } finally {
    clearTimeout(timer);
  }
}
