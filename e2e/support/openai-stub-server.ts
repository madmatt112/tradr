/**
 * Local OpenAI-shaped stub server for the e2e suite (design C8).
 *
 * The OpenAI provider adapter (apps/api/.../providers/openai.ts) is the outbound
 * choke point for OpenAI-compatible LLM calls. In e2e we must NOT hit a live LLM
 * host (non-deterministic, needs a real key). Instead the API-under-test is
 * booted with `OPENAI_BASE_URL` pointed at THIS server's `/v1` path, so both the
 * save-time `listModels` probe and the advisor stream resolve here:
 *
 *   GET  /__health             → 200 (Playwright webServer readiness probe)
 *   GET  /v1/models            → one model id, `stub-local-model`, which matches
 *                                no entry in the adapter's TOOL_USE_PREFIXES
 *                                (apps/api/.../providers/openai.ts:74-92), so the
 *                                model resolves conversation-only — the advisor
 *                                sends no `tools` with it.
 *   POST /v1/chat/completions  → records the parsed request body, then streams a
 *                                fixed text reply as server-sent events, a
 *                                `finish_reason:'stop'` chunk, a usage chunk with
 *                                `choices: []`, and `data: [DONE]`. It NEVER emits
 *                                a `tool_calls` delta (design C8; Requirement 5.4).
 *   GET  /__last-request       → the last recorded chat-completions body as JSON,
 *                                or 404 when none has been received yet.
 *
 * Used two ways:
 *   1. As a Playwright `webServer` entry — run directly (`tsx openai-stub-server.ts`),
 *      reads `LLM_STUB_PORT` from the env and listens.
 *   2. Programmatically — import { startOpenAiStubServer } for ad-hoc control.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

// This file runs as a standalone CLI (via tsx / Playwright webServer) outside
// the apps/api boot path, so it reads its port from the env directly. The
// project-wide `process.env` ban does not apply here (same carve-out as
// playwright.config.ts) — there is no `@/lib/config` module in scope.
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4605;

/** The one model this stub advertises — conversation-only (no tool-use prefix). */
export const STUB_MODEL_ID = 'stub-local-model';

/**
 * The fixed assistant reply the stream emits, split across two SSE chunks so the
 * adapter's per-chunk token accumulation is exercised. Exported so the flow-3
 * test can assert the rendered reply without the string drifting out of sync.
 */
export const STUB_REPLY_TEXT = 'This is a deterministic stub reply from the local model.';
const REPLY_CHUNKS = ['This is a deterministic stub reply ', 'from the local model.'];

export interface OpenAiStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startOpenAiStubServer(port = DEFAULT_PORT): Promise<OpenAiStubHandle> {
  // The parsed body of the most recent POST /v1/chat/completions, exposed on
  // GET /__last-request so the test can assert the advisor sent no `tools`.
  let lastChatRequest: unknown = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Test-only inspection route: the last recorded chat-completions body.
    if (url.pathname === '/__last-request') {
      if (lastChatRequest === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_request' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lastChatRequest));
      return;
    }

    // Models list — a single conversation-only model id.
    if (url.pathname === '/v1/models' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: STUB_MODEL_ID, object: 'model', created: 0, owned_by: 'tradr-e2e' }],
        }),
      );
      return;
    }

    // Chat completions — record the body, then stream the fixed reply as SSE.
    if (url.pathname === '/v1/chat/completions' && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          lastChatRequest = raw === '' ? null : (JSON.parse(raw) as unknown);
        } catch {
          lastChatRequest = { parseError: true, raw };
        }
        streamChatCompletion(res, lastChatRequest);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        server,
        port,
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

/**
 * Write the OpenAI chat-completions SSE sequence: one chunk per fixed text
 * fragment, a `finish_reason:'stop'` chunk, a usage chunk with `choices: []`,
 * then `data: [DONE]`. No `tool_calls` delta is ever emitted (Requirement 5.4).
 */
function streamChatCompletion(res: import('node:http').ServerResponse, body: unknown): void {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { model?: unknown }).model === 'string'
      ? (body as { model: string }).model
      : STUB_MODEL_ID;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const send = (obj: unknown): void => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  REPLY_CHUNKS.forEach((fragment, index) => {
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: index === 0 ? { role: 'assistant', content: fragment } : { content: fragment },
          finish_reason: null,
        },
      ],
    });
  });

  // Stop chunk — empty delta, finish_reason 'stop'.
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  // Usage chunk — no choices, usage totals only (stream_options.include_usage).
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

// CLI entrypoint: Playwright `webServer` spawns this file via tsx.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.LLM_STUB_PORT ?? DEFAULT_PORT);
  startOpenAiStubServer(port)
    .then((handle) => {
      console.log(`[openai-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[openai-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */
