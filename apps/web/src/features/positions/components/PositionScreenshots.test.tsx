// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSITION_IMAGE_MAX_BYTES, POSITION_IMAGE_MAX_COUNT } from '@tradr/shared';
import type { PositionImage } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';
import { fileToBase64 } from '@/lib/image-file';

import { PositionScreenshots } from './PositionScreenshots';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The upload/delete hooks need a QueryClient the bare mount does not provide, so
// mock the whole hooks module (design D24) and expose the mutation spies.
const { uploadMutateAsync, deleteMutate } = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock('../hooks/usePositionImages', () => ({
  positionImageUrl: (positionId: string, imageId: string) => `/img/${positionId}/${imageId}`,
  useUploadPositionImage: () => ({ mutateAsync: uploadMutateAsync }),
  useDeletePositionImage: () => ({ mutate: deleteMutate }),
}));

// The lightbox is exercised by its own suite; render it inert here.
vi.mock('./PositionImageLightbox', () => ({ PositionImageLightbox: () => null }));

// Same-origin in tests so the img omits crossOrigin.
vi.mock('@/lib/api', () => ({ isApiCrossOrigin: () => false }));

// Keep the MIME map and clipboard filter real; stub only the base64 reader so
// the encoded-length cap is deterministic.
vi.mock('@/lib/image-file', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-file')>('@/lib/image-file');
  return { ...actual, fileToBase64: vi.fn() };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function image(id: string, unavailable?: true): PositionImage {
  return {
    id,
    format: 'png',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...(unavailable ? { unavailable } : {}),
  };
}

function renderSection(images: PositionImage[]) {
  return render(
    <TooltipProvider>
      <PositionScreenshots positionId="p1" symbol="AAPL" images={images} />
    </TooltipProvider>,
  );
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

beforeEach(() => {
  vi.mocked(fileToBase64).mockResolvedValue('b64');
  uploadMutateAsync.mockResolvedValue(image('created'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PositionScreenshots', () => {
  it('disables Add screenshot at the cap and shows the limit tooltip', async () => {
    const many = Array.from({ length: POSITION_IMAGE_MAX_COUNT }, (_, i) => image(`img-${i}`));
    renderSection(many);

    const button = screen.getByRole('button', { name: 'Add screenshot' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    // The disabled button sits inside the tooltip trigger span; hover it to open.
    await userEvent.hover(button.parentElement as HTMLElement);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(`maximum of ${POSITION_IMAGE_MAX_COUNT} screenshots`);
  });

  it('renders the placeholder for an unavailable record', () => {
    renderSection([image('a', true)]);
    expect(screen.getByTestId('image-unavailable')).toBeTruthy();
  });

  it('ignores a paste while a textarea is focused', async () => {
    renderSection([]);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
    textarea.dispatchEvent(event);

    await Promise.resolve();
    expect(fileToBase64).not.toHaveBeenCalled();
    expect(uploadMutateAsync).not.toHaveBeenCalled();
    textarea.remove();
  });

  it('skips a non-image file', async () => {
    const { container } = renderSection([]);
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
    });

    await Promise.resolve();
    expect(fileToBase64).not.toHaveBeenCalled();
    expect(uploadMutateAsync).not.toHaveBeenCalled();
  });

  it('drops an oversize file with a single toast and does not upload it', async () => {
    vi.mocked(fileToBase64).mockResolvedValue('a'.repeat(POSITION_IMAGE_MAX_BYTES + 1));
    const { container } = renderSection([]);
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['x'], 'big.png', { type: 'image/png' })] },
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That image is too large to upload.'),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(uploadMutateAsync).not.toHaveBeenCalled();
  });

  it('uploads accepted files one at a time in pick order', async () => {
    vi.mocked(fileToBase64).mockImplementation((file: File) => Promise.resolve(`b64:${file.name}`));
    const { container } = renderSection([]);
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'c.webp', { type: 'image/webp' }),
    ];
    fireEvent.change(fileInput(container), { target: { files } });

    await waitFor(() => expect(uploadMutateAsync).toHaveBeenCalledTimes(3));
    expect(uploadMutateAsync.mock.calls.map((c) => c[0].format)).toEqual(['png', 'jpeg', 'webp']);
  });
});
