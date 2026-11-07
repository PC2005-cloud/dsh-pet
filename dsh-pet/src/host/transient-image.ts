/** Request-only raster bytes. These are never attachment references or chat memory records. */
export interface TransientChatImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** Accepts bounded in-memory JPEG/PNG only, rejecting network URLs and malformed image envelopes. */
export function parseTransientImage(value: unknown): TransientChatImage {
  const invalid = () => new Error('Invalid transient chat image.');
  if (typeof value !== 'object' || value === null) throw invalid();
  const image = value as Record<string, unknown>;
  if (
    typeof image.dataUrl !== 'string' ||
    image.dataUrl.length > 8 * 1024 * 1024 + 32 ||
    typeof image.width !== 'number' ||
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    image.width > 1920 ||
    typeof image.height !== 'number' ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.height > 1080
  )
    throw invalid();
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || match[2].length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 8 || bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== match[2]) throw invalid();
  const valid =
    match[1] === 'jpeg'
      ? bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!valid) throw invalid();
  return { dataUrl: image.dataUrl, width: image.width, height: image.height };
}
