import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Position screenshots e2e suite — the browser half of the decomposition's
 * verification scenario (§35), run against the booted stack. The gc half runs
 * in the CLI integration test (design D23).
 *
 * One journey with a freshly registered user: three screenshots are uploaded
 * through the section's picker (one JPEG carrying an APP1 `Exif` segment); the
 * three thumbnails survive a reload; one screenshot fetched straight from the
 * serving route comes back with its container metadata stripped (no `Exif`
 * bytes); the lightbox opens, steps with the arrow keys and closes on Escape;
 * a screenshot is deleted through its confirmation, leaving two; and an
 * oversized file is refused client-side with the too-large toast, never
 * reaching the server.
 *
 * ASSERTIONS ARE ON THE DOM AND THE NETWORK, NEVER ON REACT STATE — thumbnails
 * are read off their accessible names, the served bytes off `request.get`, and
 * the persisted set off `GET /api/positions/{id}`. Images are built in memory
 * as buffers — there are NO fixture files on disk and NO `OBJECT_STORAGE_*` in
 * the config, so this is the self-host (inline-bytes) path.
 * `ensureStackOrSkip` skips (not fails) when the API is down, matching every
 * other live suite here.
 */

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-shots-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP (5 / 15 min) and the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1` in playwright.config.ts), so a forwarded IP is
 * what the limiter keys off. The third octet — 127 — is this spec's own; every
 * other suite's range is taken. `process.pid` namespaces the worker.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.127.${ipCounter % 254}`;
}

/**
 * Register a user; the session cookie lands on `req`, so the returned context
 * stays authenticated as this user for the API-side setup and assertions.
 */
async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Log in through the form. A unique forwarded IP keeps logins out of one bucket. */
async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Skip gracefully when the API is not up, rather than failing the run. */
async function ensureStackOrSkip(req: APIRequestContext): Promise<void> {
  try {
    const res = await req.get('/api/auth/me', { failOnStatusCode: false });
    if (res.status() >= 500) {
      test.skip(true, `API stack returned ${res.status()} — skipping live e2e`);
    }
  } catch (err) {
    test.skip(true, `API stack unreachable — skipping live e2e (${(err as Error).message})`);
  }
}

const OPENED_AT = '2026-05-01T14:30:00.000Z';

/** A funded account over the API — the screenshots section is the surface under test. */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD', startingBalance: '10000' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A position the user has open with one entry fill. The entry fill MUST precede
 * `/open`: the API refuses to open a position that has none.
 */
async function createOpenPosition(req: APIRequestContext, accountId: string): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const positionId = ((await posRes.json()) as { id: string }).id;

  const entryRes = await req.post(`/api/positions/${positionId}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: OPENED_AT },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  const openRes = await req.post(`/api/positions/${positionId}/open`, {
    data: { openedAt: OPENED_AT },
  });
  expect(openRes.status(), 'POST /open').toBe(200);
  return positionId;
}

// ---------------------------------------------------------------------------
// In-memory image builders — minimal valid containers, hand-built with no image
// library (mirrors apps/api/src/lib/image-metadata.test.ts). The JPEG carries an
// APP1 `Exif` segment the server must strip; the PNG and WebP are clean.
// ---------------------------------------------------------------------------

const EXIF_MARKER = Buffer.from('Exif\x00\x00GPS_FIXTURE_LAT', 'latin1');
const PIXELS = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  const head = Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Minimal JPEG: SOI, APP1(EXIF), DQT (kept), SOS + scan, EOI. */
function buildJpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app1 = jpegSegment(0xe1, EXIF_MARKER); // APP1 = EXIF/XMP
  const dqt = jpegSegment(0xdb, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]), PIXELS]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, dqt, sos, eoi]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([0, 0, 0, 0])]);
}

/** Minimal PNG: sig, IHDR, IDAT, IEND. */
function buildPng(): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', PIXELS);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  const padded = payload.length & 1 ? Buffer.concat([payload, Buffer.from([0x00])]) : payload;
  return Buffer.concat([head, padded]);
}

/** Minimal WebP: RIFF, WEBP, one VP8 pixel chunk. */
function buildWebp(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), webpChunk('VP8 ', PIXELS)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// A PNG whose base64 encoding exceeds POSITION_IMAGE_MAX_BYTES (4,500,000): raw
// bytes over ~3.375 MB encode past the cap. ~3.6 MB → ~4.8 MB base64, refused
// client-side before any request. The bytes need not be a decodable image — the
// client caps the encoded length before it ever posts.
function buildOversizedPng(): Buffer {
  return Buffer.concat([PNG_SIG, Buffer.alloc(3_600_000, 0x7f)]);
}

// The file input is hidden behind the "Add screenshot" button; it is the only
// image picker on the detail page. `setInputFiles` works on hidden inputs.
const FILE_INPUT = 'input[accept="image/png,image/jpeg,image/webp"]';

// Matches the thumbnail open buttons only ("Open screenshot 1" … N).
const OPEN_BUTTONS = /^Open screenshot \d+$/;

test.describe('position screenshots', () => {
  // Desktop only, matching the other detail-page live suites; the section works
  // at every width, so a second mobile run would buy no coverage.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile);

  test.beforeEach(async ({ request }) => {
    await ensureStackOrSkip(request);
  });

  test('upload persists, serves stripped, lightbox, delete, refuse oversize', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'flow');
    await loginViaUi(page, email);
    const accountId = await createAccount(request, 'Screenshots account');
    const positionId = await createOpenPosition(request, accountId);

    await page.goto(`/positions/${positionId}`);
    await expect(page.getByRole('heading', { name: 'Screenshots' })).toBeVisible();
    await expect(page.getByText('No screenshots yet')).toBeVisible();

    // 1. Upload three images in one pick, in creation order. The JPEG carries an
    //    APP1 EXIF segment; the PNG and WebP are clean.
    await page.locator(FILE_INPUT).setInputFiles([
      { name: 'shot-exif.jpg', mimeType: 'image/jpeg', buffer: buildJpegWithExif() },
      { name: 'shot.png', mimeType: 'image/png', buffer: buildPng() },
      { name: 'shot.webp', mimeType: 'image/webp', buffer: buildWebp() },
    ]);
    await expect(page.getByRole('button', { name: OPEN_BUTTONS })).toHaveCount(3);

    // 2. The three thumbnails survive a reload (persistence, REQ-1.2).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Screenshots' })).toBeVisible();
    await expect(page.getByRole('button', { name: OPEN_BUTTONS })).toHaveCount(3);

    // 3. The JPEG is served with its container metadata stripped — the bytes
    //    coming back from the ownership-scoped serving route carry no `Exif`
    //    (REQ-1.4). Read the persisted ids straight from the detail endpoint.
    const detail = (await (await request.get(`/api/positions/${positionId}`)).json()) as {
      images: { id: string; format: string }[];
    };
    expect(detail.images).toHaveLength(3);
    const jpeg = detail.images.find((i) => i.format === 'jpeg');
    expect(jpeg, 'a jpeg screenshot was stored').toBeTruthy();

    const imgRes = await request.get(`/api/positions/${positionId}/images/${jpeg!.id}`);
    expect(imgRes.status(), 'serve screenshot').toBe(200);
    expect(imgRes.headers()['content-type']).toContain('image/jpeg');
    const served = await imgRes.body();
    expect(served.length).toBeGreaterThan(0);
    expect(served.includes(Buffer.from('Exif', 'latin1')), 'Exif stripped from served bytes').toBe(
      false,
    );

    // 4. The lightbox opens on a thumbnail, steps forward with ArrowRight, and
    //    closes on Escape (REQ-4.4; the dialog's accessible name is its title).
    await page.getByRole('button', { name: 'Open screenshot 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Screenshot 1 of 3' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog', { name: 'Screenshot 2 of 3' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    // 5. Delete one screenshot through its confirmation; two remain (REQ-4.5).
    await page.getByRole('button', { name: 'Delete screenshot 1' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByRole('heading', { name: 'Delete screenshot' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: OPEN_BUTTONS })).toHaveCount(2);

    // 6. An oversized file is refused before any upload — the too-large toast
    //    fires and no thumbnail is added (REQ-2.4 / 5.2, client-side cap).
    await page
      .locator(FILE_INPUT)
      .setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: buildOversizedPng() });
    await expect(page.getByText('That image is too large to upload.')).toBeVisible();
    await expect(page.getByRole('button', { name: OPEN_BUTTONS })).toHaveCount(2);
  });
});
