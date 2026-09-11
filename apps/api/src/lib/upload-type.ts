import { imageSize } from 'image-size'

export type UploadExtension = 'jpg' | 'pdf' | 'png' | 'webp'

/** Detects supported upload content without trusting its filename or MIME header. */
export function detectUploadExtension(
  bytes: Uint8Array,
): UploadExtension | undefined {
  if (
    bytes.length >= 5 &&
    new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
  ) {
    return 'pdf'
  }
  try {
    const type = imageSize(bytes).type
    return type === 'jpg' || type === 'png' || type === 'webp'
      ? type
      : undefined
  } catch {
    return undefined
  }
}
