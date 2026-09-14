import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { POSITION_IMAGE_MAX_BYTES, UploadPositionImageSchema } from '@tradr/shared';

import { db } from '@/db';
import { PositionImageTooLargeError, ValidationError } from '@/lib/errors';
import { IMAGE_CACHE_CONTROL, toArrayBuffer } from '@/lib/image-serving';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import {
  getPositionImage,
  removePositionImage,
  uploadPositionImage,
} from './position-images.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
    requestId: string;
  };
};

const positionImagesRouter = new Hono<AuthEnv>();

positionImagesRouter.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });
const ImageParamSchema = z.object({
  id: z.string().uuid(),
  imageId: z.string().uuid(),
});

// D18: the request body is one image plus ~40 bytes of JSON framing, so the body
// limit is the per-image byte cap plus a small route-local margin (NOT a shared
// constant). An oversized body is rejected (413) before it is buffered.
const POSITION_IMAGE_FRAMING_BYTES = 4_096;
const positionImageMaxRequestBytes = POSITION_IMAGE_MAX_BYTES + POSITION_IMAGE_FRAMING_BYTES;

function positionImageBodyTooLarge(c: Context<AuthEnv>) {
  const requestId = c.get('requestId') as string | undefined;
  return c.json(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${positionImageMaxRequestBytes} bytes`,
        requestId,
      },
    },
    413,
  );
}

const positionImageBodyLimit = bodyLimit({
  maxSize: positionImageMaxRequestBytes,
  onError: (c) => positionImageBodyTooLarge(c as Context<AuthEnv>),
});

/**
 * @swagger
 * /api/positions/{id}/images:
 *   post:
 *     summary: Upload a screenshot to a position.
 *     description: >
 *       Authed. Stores one screenshot (PNG, JPEG or WebP) on a position the user
 *       owns. `dataBase64` is the base64-encoded image bytes; container metadata
 *       (EXIF/XMP) is stripped server-side before storage with no re-encode. A
 *       position holds at most 10 screenshots. When object storage is configured
 *       the bytes are written to the bucket and only a pointer is persisted; a
 *       self-hosted instance keeps the bytes inline. The object-storage key is
 *       never returned. Existing-data management is never tier-gated.
 *     tags: [Positions]
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
 *             required: [format, dataBase64]
 *             properties:
 *               format: { type: string, enum: [png, jpeg, webp] }
 *               dataBase64:
 *                 type: string
 *                 description: >
 *                   Base64-encoded image bytes, at most 4,500,000 encoded bytes.
 *     responses:
 *       201:
 *         description: The stored screenshot record.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 format: { type: string, enum: [png, jpeg, webp] }
 *                 createdAt: { type: string }
 *       400: { description: 'Validation error, an image over the size cap (IMAGE_TOO_LARGE), or bytes that do not match the declared format (IMAGE_FORMAT_MISMATCH).' }
 *       404: { description: Position not found (or not owned by the user). }
 *       409: { description: The position already holds the maximum of 10 screenshots (POSITION_IMAGE_LIMIT). }
 *       413: { description: Request body exceeds the upload limit (PAYLOAD_TOO_LARGE). }
 *       503: { description: Object storage temporarily unreachable (OBJECT_UNREACHABLE). }
 */
positionImagesRouter.post(
  '/:id/images',
  validate('param', ParamSchema),
  positionImageBodyLimit,
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    // Manual safeParse (not validate('json')): an over-cap `dataBase64` carries
    // the schema's `IMAGE_TOO_LARGE` message and must surface as that 400, while
    // any other Zod failure is a plain VALIDATION_ERROR (stream.handler.ts:111-123).
    const parsed = UploadPositionImageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const details: Record<string, string> = {};
      let imageTooLarge = false;
      for (const issue of parsed.error.issues) {
        if (issue.message === 'IMAGE_TOO_LARGE') imageTooLarge = true;
        details[issue.path.join('.') || '_root'] = issue.message;
      }
      if (imageTooLarge) throw new PositionImageTooLargeError();
      throw new ValidationError('Validation failed', details);
    }

    const record = await uploadPositionImage(db, {
      positionId: id,
      userId,
      format: parsed.data.format,
      dataBase64: parsed.data.dataBase64,
    });
    return c.json(record, 201);
  },
);

/**
 * @swagger
 * /api/positions/{id}/images/{imageId}:
 *   get:
 *     summary: Serve a position screenshot (ownership-scoped).
 *     description: >
 *       Streams the bytes of one screenshot on a position the authenticated user
 *       owns. Object access is proxy-through-API — there are no presigned URLs and
 *       the object-storage key is resolved server-side, never appearing in the URL
 *       or any response. A missing/not-owned position, an unknown image id, an
 *       unrecoverable record, and a genuinely-absent object all return the
 *       identical 404 (no existence oracle). The bytes carry their stored
 *       `Content-Type` and `Cache-Control: private, max-age=300`. A transient
 *       object-store outage returns 503 (OBJECT_UNREACHABLE).
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: imageId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The image bytes.
 *         content:
 *           image/png: { schema: { type: string, format: binary } }
 *           image/jpeg: { schema: { type: string, format: binary } }
 *           image/webp: { schema: { type: string, format: binary } }
 *       404: { description: 'Not found, not owned, unrecoverable, or object gone.' }
 *       503: { description: Object storage temporarily unreachable (OBJECT_UNREACHABLE). }
 */
positionImagesRouter.get('/:id/images/:imageId', validate('param', ImageParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id, imageId } = c.req.valid('param');
  const { bytes, contentType } = await getPositionImage(db, { positionId: id, userId, imageId });
  return c.body(toArrayBuffer(bytes), 200, {
    'Content-Type': contentType,
    'Cache-Control': IMAGE_CACHE_CONTROL,
  });
});

/**
 * @swagger
 * /api/positions/{id}/images/{imageId}:
 *   delete:
 *     summary: Delete a position screenshot.
 *     description: >
 *       Authed. Removes one screenshot from a position the user owns. When the
 *       screenshot was stored as an object, its bucket object is deleted
 *       best-effort after the row is removed; a failed object delete is logged
 *       and the request still returns 204.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: imageId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Screenshot deleted. }
 *       404: { description: 'Screenshot not found (or not owned by the user).' }
 */
positionImagesRouter.delete(
  '/:id/images/:imageId',
  validate('param', ImageParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id, imageId } = c.req.valid('param');
    await removePositionImage(db, { positionId: id, userId, imageId });
    return c.body(null, 204);
  },
);

export default positionImagesRouter;
