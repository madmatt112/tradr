import { Hono } from 'hono';
import { z } from 'zod';

import { CreateTagSchema, StarterAnswerSchema, UpdateTagSchema } from '@tradr/shared/schemas/tag';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { answerStarterOffer, createTag, editTag, listTags, removeTag } from './tags.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const tagsRouter = new Hono<AuthEnv>();

tagsRouter.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });

/**
 * @swagger
 * /api/tags:
 *   get:
 *     summary: List the user's tags.
 *     description: >
 *       Authed. Returns every tag the user owns, ordered by category
 *       (Setups, Emotions, Mistakes, General) then case-insensitive name, each
 *       with the number of positions it is attached to. Tag names are unique per
 *       user case-insensitively across every category.
 *     tags: [Tags]
 *     responses:
 *       200: { description: The user's tags, each with a positionCount. }
 *       401: { description: No valid session. }
 */
tagsRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listTags(db, userId);
  return c.json(rows, 200);
});

/**
 * @swagger
 * /api/tags:
 *   post:
 *     summary: Create a tag.
 *     description: >
 *       Authed. Names are unique per user case-insensitively across every
 *       category, so the same name cannot exist twice even under different
 *       categories. Colour is optional. Subject to a per-user cap.
 *     tags: [Tags]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, category]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 40 }
 *               category: { type: string, enum: [setup, emotion, mistake, general] }
 *               color:
 *                 type: string
 *                 enum: [tag-1, tag-2, tag-3, tag-4, tag-5, tag-6]
 *                 nullable: true
 *     responses:
 *       201: { description: The created tag. }
 *       400: { description: Validation error. }
 *       401: { description: No valid session. }
 *       409:
 *         description: >
 *           `TAG_NAME_TAKEN` — a tag with this name already exists for the user
 *           (case-insensitive, across categories); or `TAG_LIMIT_REACHED` — the
 *           per-user tag cap has been reached.
 */
tagsRouter.post('/', validate('json', CreateTagSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const tag = await createTag(db, userId, data);
  return c.json(tag, 201);
});

/**
 * @swagger
 * /api/tags/starter:
 *   post:
 *     summary: Answer the starter-tags offer.
 *     description: >
 *       Authed. `accept` creates any of the sixteen starter tags the user does
 *       not already have and returns the ones it created; `decline` creates
 *       nothing. Both record that the offer was answered so it is not shown
 *       again. `accept` is idempotent by name (case-insensitive): a second
 *       accept returns an empty `created` and makes no duplicates.
 *     tags: [Tags]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answer]
 *             properties:
 *               answer: { type: string, enum: [accept, decline] }
 *     responses:
 *       200:
 *         description: >
 *           The answer and the tags an `accept` created (empty on `decline` and
 *           on an already-complete `accept`).
 *       400: { description: Validation error. }
 *       401: { description: No valid session. }
 *       409:
 *         description: >
 *           `TAG_LIMIT_REACHED` — the starter set cannot fit under the per-user
 *           tag cap.
 */
tagsRouter.post('/starter', validate('json', StarterAnswerSchema), async (c) => {
  const userId = c.get('userId');
  const { answer } = c.req.valid('json');
  const result = await answerStarterOffer(db, userId, answer);
  return c.json(result, 200);
});

/**
 * @swagger
 * /api/tags/{id}:
 *   put:
 *     summary: Edit a tag.
 *     description: >
 *       Authed. Every field is optional but at least one must be present. Names
 *       stay unique per user case-insensitively across every category; a
 *       case-only self-rename is allowed.
 *     tags: [Tags]
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
 *             minProperties: 1
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 40 }
 *               category: { type: string, enum: [setup, emotion, mistake, general] }
 *               color:
 *                 type: string
 *                 enum: [tag-1, tag-2, tag-3, tag-4, tag-5, tag-6]
 *                 nullable: true
 *     responses:
 *       200: { description: The updated tag. }
 *       400: { description: Validation error. }
 *       401: { description: No valid session. }
 *       404: { description: No such tag for this user. }
 *       409:
 *         description: >
 *           `TAG_NAME_TAKEN` — a tag with this name already exists for the user
 *           (case-insensitive, across categories).
 */
tagsRouter.put(
  '/:id',
  validate('param', ParamSchema),
  validate('json', UpdateTagSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const tag = await editTag(db, id, userId, data);
    return c.json(tag, 200);
  },
);

/**
 * @swagger
 * /api/tags/{id}:
 *   delete:
 *     summary: Delete a tag.
 *     description: >
 *       Authed. Removing a tag detaches it from every position it was attached
 *       to; it is never refused for being in use.
 *     tags: [Tags]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       401: { description: No valid session. }
 *       404: { description: No such tag for this user. }
 */
tagsRouter.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removeTag(db, id, userId);
  return c.body(null, 204);
});

export default tagsRouter;
