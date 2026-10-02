import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCAN_OPTIONS,
  imageFormat,
  resolveScanOptions,
  scanItem,
  summarizeScan,
  type ScanMediaItem,
} from '../src/scanner.ts';

function image(overrides: Partial<ScanMediaItem>): ScanMediaItem {
  return { id: 'm1', mimeType: 'image/jpeg', size: 200_000, width: 1200, height: 800, ...overrides };
}

// With the default maxDimension of 2560, a 4000 x 3000 image scales by 0.64, keeping 0.4096 of its area.

describe('lossy formats', () => {
  it('leaves a well-sized, typically encoded JPEG alone', () => {
    expect(scanItem(image({}))).toEqual({ status: 'ok', id: 'm1', format: 'jpeg' });
  });

  it('estimates resizing and re-encoding for an oversized, heavy JPEG', () => {
    // 12 MP at 0.5 B/px; target 12e6 * 0.4096 * 0.25 = 1_228_800 bytes.
    const result = scanItem(image({ size: 6_000_000, width: 4000, height: 3000 }));
    expect(result).toEqual({
      status: 'flagged',
      id: 'm1',
      format: 'jpeg',
      findings: ['oversized-dimensions', 'heavy-encoding'],
      estimate: { bytes: 4_771_200, basis: 'resize-and-reencode' },
    });
  });

  it('estimates only the resize when the encoding is already light', () => {
    // 0.2 B/px is below the JPEG typical density, so the saving is the removed area.
    const result = scanItem(image({ size: 2_400_000, width: 4000, height: 3000 }));
    expect(result).toMatchObject({
      findings: ['oversized-dimensions'],
      estimate: { bytes: 1_416_960, basis: 'resize' },
    });
  });

  it('flags heavy encoding without a resize', () => {
    // 0.625 B/px; target 960_000 * 0.25 = 240_000 bytes.
    const result = scanItem(image({ size: 600_000 }));
    expect(result).toMatchObject({
      findings: ['heavy-encoding'],
      estimate: { bytes: 360_000, basis: 'resize-and-reencode' },
    });
  });

  it('uses a lower typical density for AVIF than for JPEG', () => {
    // 0.2 B/px is light for JPEG but heavy for AVIF (0.12 B/px): target 115_200, saving 76_800.
    expect(scanItem(image({ size: 192_000 })).status).toBe('ok');
    expect(scanItem(image({ mimeType: 'image/avif', size: 192_000 }))).toMatchObject({
      format: 'avif',
      findings: ['heavy-encoding'],
      estimate: { bytes: 76_800 },
    });
  });
});

describe('reporting thresholds', () => {
  it('drops a saving below the byte threshold', () => {
    // Slightly over the limit: 500_000 * (1 - (2560 / 2600)^2) is about 15 KB.
    expect(scanItem(image({ size: 500_000, width: 2600, height: 1000 })).status).toBe('ok');
  });

  it('drops a saving below the ratio threshold', () => {
    // A light JPEG scaled from 4000 to 3795 px loses about 10% of its area, so about 10% of 3.2 MB.
    const options = resolveScanOptions({ minSavingsBytes: 0, maxDimension: 3795 });
    const item = image({ size: 3_200_000, width: 4000, height: 4000 });
    expect(scanItem(item, options).status).toBe('ok');
    expect(scanItem(item, { ...options, minSavingsRatio: 0.05 }).status).toBe('flagged');
  });

  it('reports a saving exactly at both thresholds and nothing below either', () => {
    // 0.5 B/px over 409_600 px; target 409_600 * 0.25 = 102_400, so the saving is exactly half.
    const item = image({ size: 204_800, width: 640, height: 640 });
    const exact = resolveScanOptions({ minSavingsBytes: 102_400, minSavingsRatio: 0.5 });
    expect(scanItem(item, exact)).toMatchObject({ status: 'flagged', estimate: { bytes: 102_400 } });
    expect(scanItem(item, { ...exact, minSavingsBytes: 102_401 }).status).toBe('ok');
    expect(scanItem(item, { ...exact, minSavingsRatio: 0.500001 }).status).toBe('ok');
  });
});

describe('lossless formats', () => {
  it('estimates only the resize for an oversized PNG graphic', () => {
    const result = scanItem(image({ mimeType: 'image/png', size: 3_000_000, width: 4000, height: 3000 }));
    expect(result).toEqual({
      status: 'flagged',
      id: 'm1',
      format: 'png',
      findings: ['oversized-dimensions'],
      estimate: { bytes: 1_771_200, basis: 'resize' },
    });
  });

  it('marks a dense PNG as a possible photo without estimating a saving', () => {
    const result = scanItem(image({ mimeType: 'image/png', size: 2_000_000, width: 1000, height: 1000 }));
    expect(result).toEqual({
      status: 'flagged',
      id: 'm1',
      format: 'png',
      findings: ['possible-photo-as-png'],
      estimate: null,
    });
  });

  it('keeps the advisory finding when the resize saving is too small to report', () => {
    const result = scanItem(image({ mimeType: 'image/png', size: 5_200_000, width: 2600, height: 1000 }));
    // The resize saves about 3%, below the ratio threshold.
    expect(result).toMatchObject({ findings: ['possible-photo-as-png'], estimate: null });
  });

  it('reports BMP and TIFF as uncompressed formats', () => {
    for (const mimeType of ['image/bmp', 'image/x-ms-bmp', 'image/tiff']) {
      const result = scanItem(image({ mimeType, size: 1_440_054, width: 800, height: 600 }));
      expect(result).toMatchObject({ status: 'flagged', findings: ['uncompressed-format'], estimate: null });
    }
  });
});

describe('formats', () => {
  it('normalizes case, parameters and common aliases', () => {
    expect(imageFormat(' IMAGE/JPEG; charset=binary')).toBe('jpeg');
    expect(imageFormat('image/jpg')).toBe('jpeg');
    expect(imageFormat('image/pjpeg')).toBe('jpeg');
  });

  it('skips images the scan has no model for, and non-images', () => {
    for (const mimeType of ['image/gif', 'image/svg+xml', 'image/heic', 'image/']) {
      expect(scanItem(image({ mimeType }))).toEqual({ status: 'skipped', id: 'm1', reason: 'unsupported-format' });
    }
    for (const mimeType of ['application/pdf', 'video/mp4', '', 'imagejpeg']) {
      expect(scanItem(image({ mimeType }))).toEqual({ status: 'skipped', id: 'm1', reason: 'not-an-image' });
    }
  });
});

describe('missing and invalid metadata', () => {
  it('skips items without a size or dimensions', () => {
    expect(scanItem(image({ size: null }))).toMatchObject({ reason: 'missing-size' });
    expect(scanItem(image({ width: null }))).toMatchObject({ reason: 'missing-dimensions' });
    expect(scanItem(image({ height: undefined }))).toMatchObject({ reason: 'missing-dimensions' });
  });

  it('refuses metadata that is not a positive safe integer', () => {
    const invalid: Partial<ScanMediaItem>[] = [
      { size: 0 },
      { size: -1 },
      { size: 1.5 },
      { size: Number.NaN },
      { size: Number.POSITIVE_INFINITY },
      { size: 2 ** 53 },
      { width: 0 },
      { width: -1200 },
      { height: 800.5 },
      { height: Number.NaN },
      { width: 2 ** 53 },
      { size: '200000' as unknown as number },
      { width: '1200' as unknown as number },
      { mimeType: 42 as unknown as string },
    ];
    for (const overrides of invalid) {
      expect(scanItem(image(overrides)), JSON.stringify(overrides)).toMatchObject({
        status: 'skipped',
        reason: 'invalid-metadata',
      });
    }
  });

  it('gives a finite estimate for the largest accepted dimensions', () => {
    const result = scanItem(image({ size: Number.MAX_SAFE_INTEGER, width: 1_000_000, height: 1_000_000 }));
    expect(result.status).toBe('flagged');
    if (result.status === 'flagged') expect(Number.isSafeInteger(result.estimate?.bytes)).toBe(true);
  });
});

describe('options', () => {
  it('defaults to the documented values', () => {
    expect(resolveScanOptions()).toEqual(DEFAULT_SCAN_OPTIONS);
    expect(resolveScanOptions({ maxDimension: 1920 }).maxDimension).toBe(1920);
  });

  it('rejects values the scan cannot use', () => {
    for (const options of [
      { maxDimension: 0 },
      { maxDimension: 1920.5 },
      { maxDimension: Number.NaN },
      { minSavingsBytes: -1 },
      { minSavingsBytes: Number.POSITIVE_INFINITY },
      { minSavingsRatio: -0.1 },
      { minSavingsRatio: 1.1 },
      { minSavingsRatio: Number.NaN },
    ]) {
      expect(() => resolveScanOptions(options), JSON.stringify(options)).toThrow(RangeError);
    }
  });
});

describe('summary', () => {
  it('counts each outcome and totals only the estimated savings', () => {
    const results = [
      scanItem(image({ id: 'ok' })),
      scanItem(image({ id: 'heavy', size: 600_000 })),
      scanItem(image({ id: 'photo', mimeType: 'image/png', size: 2_000_000, width: 1000, height: 1000 })),
      scanItem(image({ id: 'gif', mimeType: 'image/gif' })),
      scanItem(image({ id: 'pdf', mimeType: 'application/pdf' })),
      scanItem(image({ id: 'bad', size: -1 })),
    ];
    expect(summarizeScan(results)).toEqual({
      scanned: 6,
      flagged: 2,
      ok: 1,
      skipped: {
        'not-an-image': 1,
        'unsupported-format': 1,
        'missing-size': 0,
        'missing-dimensions': 0,
        'invalid-metadata': 1,
      },
      estimatedSavingsBytes: 360_000,
    });
  });
});
