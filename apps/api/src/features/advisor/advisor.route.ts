import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ADVISOR_MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES_DEFAULT } from '@tradr/shared';

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  createPersonaHandler,
  deleteConversationHandler,
  deletePersonaHandler,
  getConversationHandler,
  listConversationsHandler,
  listMessagesHandler,
  listModelsHandler,
  listPersonasHandler,
  renameConversationHandler,
  setDefaultPersonaHandler,
  updatePersonaHandler,
} from './crud.handler';
import {
  deleteMarketDataKeyHandler,
  getMarketDataKeyHandler,
  getTradeDataConsentHandler,
  saveMarketDataKeyHandler,
  setTradeDataConsentHandler,
} from './external-keys.handler';
import { getMessageImageHandler } from './image-proxy.handler';
import { getOptionsChainHandler } from './options-chain.handler';
import {
  deleteProviderKeyHandler,
  listProviderKeysHandler,
  patchProviderKeyHandler,
  saveProviderKeyHandler,
} from './provider-keys.handler';
import { streamHandler } from './stream.handler';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
    requestId: string;
  };
};

const advisorRouter = new Hono<AuthEnv>();

advisorRouter.use(authMiddleware);

// Smoke endpoint (v4-3) — permanent router-mount sanity check.
advisorRouter.get('/_health', (c) => c.json({ ok: true, router: 'advisor' }));

// === streaming endpoints (Task 24) ===
// Per-user (REQ-3) streaming rate limiter — mounted on the streaming endpoint
// only (design §Component 7): max 30 streams per 60 s. Keyed on the
// authenticated userId (set by authMiddleware) so the cap is the billing cap:
// NAT'd users do not collide and one user across multiple IPs cannot double it.
const perUserRateLimit = createRateLimiter({
  name: 'stream',
  max: 30,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8): a
  // userId-keyed cost limiter, not the brute-force surface — not tightened.
  fallbackMax: 30,
});

// === streaming request-body floor (Task 12; design §Component 3, REQ-4) ===
// The per-image cap (schema `.max()`, enforced in stream.handler) bounds ONE
// image; this bounds the whole REQUEST BODY only (NOT the SSE response). The
// default is DERIVED so a full max-images message plus text plus JSON framing
// fits under it — and under the nginx MAX_UPLOAD_SIZE ceiling (REQ-4.4). An
// operator override (ADVISOR_MAX_REQUEST_BYTES) has no schema default, so the
// `??` fallback is required — `maxSize` must never receive `undefined`.
const STREAM_TEXT_MAX_BYTES = 50_000; // matches StreamRequestSchema `text.max(50_000)`
const STREAM_FRAMING_BYTES = 64_000; // JSON envelope / field names / UUIDs margin
const perImageMaxBytes = config.ADVISOR_IMAGE_MAX_BYTES ?? MAX_IMAGE_BYTES_DEFAULT;
const combinedImageCap = perImageMaxBytes * ADVISOR_MAX_IMAGES_PER_MESSAGE;
const derivedMaxRequestBytes = combinedImageCap + STREAM_TEXT_MAX_BYTES + STREAM_FRAMING_BYTES;
const streamMaxRequestBytes = config.ADVISOR_MAX_REQUEST_BYTES ?? derivedMaxRequestBytes;

// Startup warn (REQ-4.6): an override below the combined per-message image cap
// would 413 a legitimate multi-image message before the per-image schema cap can
// accept it. Only warns when an override is actually set.
if (
  config.ADVISOR_MAX_REQUEST_BYTES !== undefined &&
  config.ADVISOR_MAX_REQUEST_BYTES < combinedImageCap
) {
  logger.warn('ADVISOR_MAX_REQUEST_BYTES is below the combined per-message image cap', {
    advisorMaxRequestBytes: config.ADVISOR_MAX_REQUEST_BYTES,
    combinedImageCap,
    perImageMaxBytes,
    maxImagesPerMessage: ADVISOR_MAX_IMAGES_PER_MESSAGE,
  });
}

function streamBodyTooLargeResponse(c: Context<AuthEnv>) {
  const requestId = c.get('requestId') as string | undefined;
  return c.json(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${streamMaxRequestBytes} bytes`,
        requestId,
      },
    },
    413,
  );
}

// Mounted FIRST on both stream routes so an oversized body is rejected (413)
// before it is buffered — and before the rate limiter spend budget.
const streamBodyLimit = bodyLimit({
  maxSize: streamMaxRequestBytes,
  onError: (c) => streamBodyTooLargeResponse(c as Context<AuthEnv>),
});

/**
 * @swagger
 * /api/advisor/conversations/{id}/messages/stream:
 *   post:
 *     summary: Stream an assistant reply for an existing conversation (SSE).
 *     description: >
 *       Sends a user message to an existing conversation and streams the
 *       assistant reply as Server-Sent Events. Frames: `event: token`
 *       (`{delta}`), `event: usage` (`{promptTokens, completionTokens}`),
 *       `event: done` (`{messageId, deduped?, source?}`), `event: error`
 *       (`{code, upstreamStatus, message}`). Pre-stream failures return a JSON
 *       error envelope (no SSE) with the appropriate HTTP status.
 *       Rate limited to 30 requests per 60 s.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientMessageId, text]
 *             properties:
 *               clientMessageId: { type: string, format: uuid }
 *               text: { type: string, minLength: 1, maxLength: 50000 }
 *               personaId: { type: string }
 *               attachments:
 *                 type: array
 *                 maxItems: 4
 *                 items:
 *                   type: object
 *                   properties:
 *                     type: { type: string, enum: [image] }
 *                     format: { type: string, enum: [png, jpeg, webp] }
 *                     dataBase64: { type: string, maxLength: 4500000 }
 *     responses:
 *       200:
 *         description: Server-Sent Event stream.
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *       400: { description: Validation / image / cap error envelope (IMAGE_TOO_LARGE above the per-image byte cap). }
 *       402: { description: Platform billing refusal — INSUFFICIENT_CREDITS / ALLOWANCE_EXHAUSTED (allowance model + allowance and credits exhausted) / INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE (non-allowance model + free allowance turns remain) / MODEL_NOT_AVAILABLE / BILLING_NOT_AVAILABLE. }
 *       403: { description: Monthly advisor image quota exceeded for the user's tier (TIER_LIMIT_IMAGES) — text-only turns unaffected. }
 *       404: { description: Conversation not found (or not owned). }
 *       413: { description: Request body exceeds the byte-cap floor (PAYLOAD_TOO_LARGE). }
 *       429: { description: 'Stream in progress, retry-while-in-flight, or rate limit.' }
 *       500: { description: Provider-key decryption failure. }
 */
advisorRouter.post(
  '/conversations/:id/messages/stream',
  streamBodyLimit,
  perUserRateLimit,
  streamHandler,
);

/**
 * @swagger
 * /api/advisor/conversations/new/messages/stream:
 *   post:
 *     summary: Start a new conversation and stream the assistant reply (SSE).
 *     description: >
 *       New-conversation variant of the streaming endpoint. The provider and
 *       model are seeded from the caller's stored provider key. Same SSE frame
 *       shapes and rate limit (30 / 60 s) as the existing-conversation endpoint.
 *     tags: [Advisor]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientMessageId, text]
 *             properties:
 *               clientMessageId: { type: string, format: uuid }
 *               text: { type: string, minLength: 1, maxLength: 50000 }
 *               personaId: { type: string }
 *               attachments:
 *                 type: array
 *                 maxItems: 4
 *                 items:
 *                   type: object
 *                   properties:
 *                     type: { type: string, enum: [image] }
 *                     format: { type: string, enum: [png, jpeg, webp] }
 *                     dataBase64: { type: string, maxLength: 4500000 }
 *     responses:
 *       200:
 *         description: Server-Sent Event stream.
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *       400: { description: Validation / image / cap error envelope (IMAGE_TOO_LARGE above the per-image byte cap). }
 *       402: { description: Platform billing refusal — INSUFFICIENT_CREDITS / ALLOWANCE_EXHAUSTED (allowance model + allowance and credits exhausted) / INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE (non-allowance model + free allowance turns remain) / MODEL_NOT_AVAILABLE / BILLING_NOT_AVAILABLE. }
 *       403: { description: Monthly advisor image quota exceeded for the user's tier (TIER_LIMIT_IMAGES) — text-only turns unaffected. }
 *       413: { description: Request body exceeds the byte-cap floor (PAYLOAD_TOO_LARGE). }
 *       429: { description: Stream in progress or rate limit. }
 *       500: { description: Provider-key decryption failure. }
 */
advisorRouter.post(
  '/conversations/new/messages/stream',
  streamBodyLimit,
  perUserRateLimit,
  streamHandler,
);

// === CRUD endpoints (Task 25) ===

/**
 * @swagger
 * /api/advisor/conversations:
 *   get:
 *     summary: List the authenticated user's conversations (cursor-paginated).
 *     description: >
 *       Returns conversations sorted by `updatedAt` descending with cursor-based
 *       pagination. Default limit 25, max 100. Response:
 *       `{ items: ConversationListItem[], nextCursor: string | null }`.
 *     tags: [Advisor]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       200: { description: Paginated conversation list. }
 *       400: { description: Malformed cursor or limit. }
 */
advisorRouter.get('/conversations', listConversationsHandler);

/**
 * @swagger
 * /api/advisor/conversations/{id}:
 *   get:
 *     summary: Get a conversation plus its latest 50 messages.
 *     description: >
 *       Returns `{ conversation, messages, nextCursor }`. 404 if the
 *       conversation does not exist OR is owned by another user (identical
 *       envelope — no information leak).
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Conversation with its newest message page. }
 *       404: { description: Conversation not found (or not owned). }
 *   patch:
 *     summary: Rename a conversation.
 *     description: >
 *       Updates the conversation `title` (1–200 chars; whitespace-only
 *       rejected) and bumps `updatedAt`. 404 if the conversation does not
 *       exist OR is owned by another user (identical envelope — no leak).
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string, minLength: 1, maxLength: 200 }
 *     responses:
 *       200: { description: The updated conversation. }
 *       400: { description: Invalid title. }
 *       404: { description: Conversation not found (or not owned). }
 *   delete:
 *     summary: Delete a conversation (cascades to its messages).
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: Conversation not found (or not owned). }
 */
advisorRouter.get('/conversations/:id', getConversationHandler);
advisorRouter.patch('/conversations/:id', renameConversationHandler);
advisorRouter.delete('/conversations/:id', deleteConversationHandler);

/**
 * @swagger
 * /api/advisor/conversations/{id}/messages:
 *   get:
 *     summary: List a conversation's messages (newest-first, cursor-paginated).
 *     description: >
 *       Cursor encodes the `(created_at, id)` tuple of the last-seen message.
 *       Default limit 50, max 100. 404 if the conversation is not owned.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *     responses:
 *       200: { description: Paginated message page. }
 *       404: { description: Conversation not found (or not owned). }
 */
advisorRouter.get('/conversations/:id/messages', listMessagesHandler);

/**
 * @swagger
 * /api/advisor/conversations/{conversationId}/messages/{messageId}/images/{index}:
 *   get:
 *     summary: Proxy an advisor message image by index (ownership-scoped).
 *     description: >
 *       Streams the bytes of the image content-part at `index` on a message the
 *       authenticated user owns. Object access is proxy-through-API — there are NO
 *       presigned URLs and the object-storage key is resolved server-side, never
 *       appearing in the URL or any response (no IDOR leak —). Side-effect-free. A
 *       missing/not-owned conversation or message, an out-of-range or non-image index,
 *       an `unrecoverable` marker, and a genuinely-absent object all return the
 *       identical 404 (no existence oracle). A pointer image is fetched from object
 *       storage and returned with its stored `Content-Type`; an inline image is decoded
 *       from base64. Both carry `Cache-Control: private, max-age=300`. A transient
 *       object-store outage returns 503 (OBJECT_UNREACHABLE).
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: index
 *         required: true
 *         schema: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: The image bytes.
 *         content:
 *           image/png: { schema: { type: string, format: binary } }
 *           image/jpeg: { schema: { type: string, format: binary } }
 *           image/webp: { schema: { type: string, format: binary } }
 *       404: { description: 'Not found, not owned, out of range, non-image, unrecoverable, or object gone.' }
 *       503: { description: Object storage temporarily unreachable (OBJECT_UNREACHABLE). }
 */
advisorRouter.get(
  '/conversations/:conversationId/messages/:messageId/images/:index',
  getMessageImageHandler,
);

/**
 * @swagger
 * /api/advisor/personas:
 *   get:
 *     summary: List built-in personas plus the user's own personas.
 *     tags: [Advisor]
 *     responses:
 *       200: { description: '{ items: Persona[] } — built-ins have isBuiltin: true.' }
 *   post:
 *     summary: Create a user-owned persona.
 *     tags: [Advisor]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, systemPrompt]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 80 }
 *               description: { type: string, maxLength: 500 }
 *               systemPrompt: { type: string, minLength: 1, maxLength: 5000 }
 *     responses:
 *       201: { description: The created persona. }
 *       400: { description: Validation error. }
 */
advisorRouter.get('/personas', listPersonasHandler);
advisorRouter.post('/personas', createPersonaHandler);

/**
 * @swagger
 * /api/advisor/personas/{id}:
 *   patch:
 *     summary: Update a user-owned persona.
 *     description: >
 *       Any subset of `{ name, description, systemPrompt }`. Rejected with 403
 *       for built-in personas. 404 if not owned.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 80 }
 *               description: { type: string, maxLength: 500 }
 *               systemPrompt: { type: string, minLength: 1, maxLength: 5000 }
 *     responses:
 *       200: { description: The updated persona. }
 *       403: { description: Built-in personas cannot be edited. }
 *       404: { description: Persona not found (or not owned). }
 *   delete:
 *     summary: Delete a user-owned persona.
 *     description: >
 *       Rejected with 403 for built-in personas; 409 if the persona is the
 *       user's current default (change default first). Referencing
 *       conversations are left with persona_id = NULL.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: Deleted. }
 *       403: { description: Built-in personas cannot be deleted. }
 *       404: { description: Persona not found (or not owned). }
 *       409: { description: Persona is the current default. }
 */
advisorRouter.patch('/personas/:id', updatePersonaHandler);
advisorRouter.delete('/personas/:id', deletePersonaHandler);

/**
 * @swagger
 * /api/advisor/personas/{id}/default:
 *   post:
 *     summary: Set a persona as the user's default for new conversations.
 *     description: >
 *       Atomic flip: for a user-owned persona, clears the prior default and sets this
 *       one; in all cases records the chosen persona on the user row. 404 if the
 *       persona is neither built-in nor owned.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: Default updated. }
 *       404: { description: Persona not found (or not owned). }
 */
advisorRouter.post('/personas/:id/default', setDefaultPersonaHandler);

/**
 * @swagger
 * /api/advisor/models:
 *   get:
 *     summary: List available models across the user's configured providers.
 *     description: >
 *       Returns the cached `ProviderModel[]` for every provider the user has a
 *       key for, each item tagged with its `providerId` (claude | openai) so
 *       clients can scope per-provider selectors. Served from the shared
 *       ListModelsCache (10-minute TTL).
 *       Response: `{ items: (ProviderModel & { providerId })[] }`.
 *     tags: [Advisor]
 *     responses:
 *       200: { description: '{ items: (ProviderModel & { providerId })[] }.' }
 *       500: { description: A provider key could not be decrypted. }
 */
advisorRouter.get('/models', listModelsHandler);

// === provider-key endpoints (Task 26) ===
// Per-user (REQ-5.9) save rate limiter — mounted on PUT only (design §Component
// 7): max 10 saves per user per hour, to blunt credential-stuffing-style key
// probing. Keyed on the authenticated userId so the cap is per-account, not
// per-IP (NAT'd users do not collide; one user across multiple IPs cannot
// double it). List and DELETE are not rate-limited beyond the global limiter.
const perUserKeySaveRateLimit = createRateLimiter({
  name: 'provider-keys',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8; not tightened).
  fallbackMax: 10,
});

/**
 * @swagger
 * /api/advisor/provider-keys:
 *   get:
 *     summary: List the authenticated user's configured provider keys.
 *     description: >
 *       Returns one item per provider the user has stored a BYOK key for. The plaintext
 *       key is NEVER returned — only a masking hint (`keyHintTail`, the last four
 *       characters), the chosen `defaultModel`, and `lastUsedAt`. Response: `{ items:
 *       ProviderKeyListItem[] }`.
 *     tags: [Advisor]
 *     responses:
 *       200: { description: '{ items: ProviderKeyListItem[] } — no key material.' }
 */
advisorRouter.get('/provider-keys', listProviderKeysHandler);

/**
 * @swagger
 * /api/advisor/provider-keys/{providerId}:
 *   put:
 *     summary: Save (or replace) the BYOK key for a provider.
 *     description: >
 *       Encrypts the supplied key at rest (AES-256-GCM) and stores only the ciphertext
 *       plus a last-4-char masking hint — the plaintext is never persisted or returned.
 *       Runs a lightweight validation roundtrip against the provider's listModels
 *       endpoint (5s timeout): a 401/403 rejects the save with `PROVIDER_KEY_INVALID`;
 *       a successful probe returns `verified: true`; a timeout or transient failure
 *       stores the key anyway and returns `verified: false`. Rate limited to 10 saves
 *       per user per hour. `defaultModel` is optional — when omitted (a first-time save
 *       has no model list to pick from), the server selects the provider's
 *       deterministic default from the probe's listModels response; the user can change
 *       it later.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: providerId
 *         required: true
 *         schema: { type: string, enum: [claude, openai] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [apiKey]
 *             properties:
 *               apiKey: { type: string, minLength: 8 }
 *               defaultModel: { type: string, minLength: 1, maxLength: 64 }
 *     responses:
 *       200: { description: 'The stored key (ProviderKeyListItem) plus `verified: boolean`.' }
 *       400: { description: 'Validation error or PROVIDER_KEY_INVALID (key rejected by provider).' }
 *       429: { description: Save rate limit reached (10 / hour). }
 *   patch:
 *     summary: Change the default model for an existing provider key.
 *     description: >
 *       Updates ONLY the default model — the stored key material is untouched
 *       and never re-supplied, so no validation probe runs and the save rate
 *       limit does not apply. An unknown model id still fails at stream time
 *       (MODEL_NOT_LISTED), mirroring PUT.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: providerId
 *         required: true
 *         schema: { type: string, enum: [claude, openai] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [defaultModel]
 *             properties:
 *               defaultModel: { type: string, minLength: 1, maxLength: 64 }
 *     responses:
 *       200: { description: 'The updated key (ProviderKeyListItem, no key material).' }
 *       400: { description: Validation error. }
 *       404: { description: No key configured for this provider. }
 *   delete:
 *     summary: Remove the BYOK key for a provider.
 *     description: >
 *       Hard-deletes the stored key for the authenticated user. The ciphertext
 *       is gone from the database; the plaintext was never persisted.
 *     tags: [Advisor]
 *     parameters:
 *       - in: path
 *         name: providerId
 *         required: true
 *         schema: { type: string, enum: [claude, openai] }
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: No key configured for this provider. }
 */
advisorRouter.put('/provider-keys/:providerId', perUserKeySaveRateLimit, saveProviderKeyHandler);
advisorRouter.patch('/provider-keys/:providerId', patchProviderKeyHandler);
advisorRouter.delete('/provider-keys/:providerId', deleteProviderKeyHandler);

// === market-data-key endpoints (Task 9; design §Component 5) ===
// Per-user (REQ-6.2) save rate limiter — mounted on PUT only: 10 saves per user
// per hour, mirroring the LLM provider-key limiter. A distinct instance so the
// market-data bucket does not share counts with the provider-key endpoint.
const perUserMarketDataKeySaveRateLimit = createRateLimiter({
  name: 'market-data-keys',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8; not tightened).
  fallbackMax: 10,
});

/**
 * @swagger
 * /api/advisor/market-data-key:
 *   get:
 *     summary: Get the masked status of the authenticated user's Unusual Whales key.
 *     description: >
 *       Returns the market-data (Unusual Whales) BYOK key status. The plaintext is
 *       NEVER returned — only `configured`, a last-4-char masking hint (`keyHintTail`),
 *       and the `verified` flag. When no key is stored the response is `{ configured:
 *       false }`.
 *     tags: [Advisor]
 *     responses:
 *       200: { description: '{ configured: false } or { configured: true, keyHintTail, verified } — no key material.' }
 *   put:
 *     summary: Save (or replace) the Unusual Whales market-data key.
 *     description: >
 *       Encrypts the supplied key at rest (AES-256-GCM) and stores only the ciphertext
 *       plus a last-4-char masking hint — the plaintext is never persisted or returned.
 *       Runs a lightweight verification probe: a 401/403 rejects the save with
 *       `MARKET_DATA_KEY_INVALID`; a successful probe returns `verified: true`; a
 *       transient failure (timeout / upstream unavailable) stores the key anyway and
 *       returns `verified: false`. Rate limited to 10 saves per user per hour.
 *     tags: [Advisor]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [apiKey]
 *             properties:
 *               apiKey: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: '{ configured: true, keyHintTail, verified: boolean }.' }
 *       400: { description: 'Validation error or MARKET_DATA_KEY_INVALID (key rejected by Unusual Whales).' }
 *       429: { description: Save rate limit reached (10 / hour). }
 *   delete:
 *     summary: Remove the Unusual Whales market-data key.
 *     description: >
 *       Hard-deletes the stored key for the authenticated user. The ciphertext is
 *       gone from the database; the plaintext was never persisted.
 *     tags: [Advisor]
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: No market-data key configured. }
 */
advisorRouter.get('/market-data-key', getMarketDataKeyHandler);
advisorRouter.put('/market-data-key', perUserMarketDataKeySaveRateLimit, saveMarketDataKeyHandler);
advisorRouter.delete('/market-data-key', deleteMarketDataKeyHandler);

// === trade-data-consent endpoints (Task 23; design §Component 1/3) ===

/**
 * @swagger
 * /api/advisor/trade-data-consent:
 *   get:
 *     summary: Get the authenticated user's trade-data consent flag.
 *     description: >
 *       Returns whether the user has consented to the advisor reading their stored
 *       trade data. Defaults to `false` for a user who has never set it. Response: `{
 *       consent: boolean }`.
 *     tags: [Advisor]
 *     responses:
 *       200: { description: '{ consent: boolean }.' }
 *   put:
 *     summary: Set the authenticated user's trade-data consent flag.
 *     description: >
 *       Grants or revokes the advisor's access to the user's stored trade data.
 *       Revoking consent stops new trade-data reads and removes stored structured
 *       trade-data from what is replayed to the provider; it cannot remove figures
 *       already disclosed in prior replies. Consent is re-read on every provider
 *       round-trip, so a change takes effect on the next iteration of an in-flight
 *       turn.
 *     tags: [Advisor]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [consent]
 *             properties:
 *               consent: { type: boolean }
 *     responses:
 *       200: { description: '{ consent: boolean } — the stored flag.' }
 *       400: { description: Validation error. }
 */
advisorRouter.get('/trade-data-consent', getTradeDataConsentHandler);
advisorRouter.put('/trade-data-consent', setTradeDataConsentHandler);

// === options-chain viewer endpoint (Task 35; design §Component 12) ===

/**
 * @swagger
 * /api/advisor/options-chain:
 *   get:
 *     summary: Get the live options chain for a symbol from Unusual Whales.
 *     description: >
 *       Backs the options-tools page chain viewer. Shares the Unusual Whales client and
 *       the `market_data_options_chain` tool's parsing (no duplicate fetch logic). When
 *       the authenticated user has no Unusual Whales key the response is `{ configured:
 *       false }` so the viewer shows an empty-state CTA to Settings, not an error. With
 *       a key the response is `{ configured: true, chain }` where `chain` is the
 *       compact projection `{ symbol, expiration?, count, contracts[] }`. Upstream
 *       failures are mapped to their reason codes on the matching HTTP status: 400
 *       MARKET_DATA_KEY_INVALID, 429 MARKET_DATA_RATE_LIMITED / PLATFORM_RATE_LIMITED,
 *       404 SYMBOL_NOT_FOUND, 503 MARKET_DATA_UNAVAILABLE. The plaintext key is never
 *       returned or logged.
 *     tags: [Advisor]
 *     parameters:
 *       - in: query
 *         name: symbol
 *         required: true
 *         schema: { type: string, pattern: '^[A-Z.]{1,6}$' }
 *       - in: query
 *         name: expiration
 *         schema: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' }
 *     responses:
 *       200: { description: '{ configured: false } or { configured: true, chain }.' }
 *       400: { description: 'Validation error or MARKET_DATA_KEY_INVALID.' }
 *       404: { description: SYMBOL_NOT_FOUND. }
 *       429: { description: 'MARKET_DATA_RATE_LIMITED or PLATFORM_RATE_LIMITED.' }
 *       503: { description: MARKET_DATA_UNAVAILABLE. }
 */
advisorRouter.get('/options-chain', getOptionsChainHandler);

export { advisorRouter };
