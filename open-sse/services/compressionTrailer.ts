/**
 * LEV fork: SSE compression trailer injection (Phase 4.4).
 *
 * Adds a trailing SSE comment event before the [DONE] marker when
 * compression/compaction occurred during the request:
 *
 *   : x-omniroute-compression: mode=lite, ratio=0.65, tokens_before=122000, tokens_after=78000
 *
 *   data: [DONE]
 *
 * SSE comment lines (starting with ":") are ignored by compliant SSE clients
 * but visible to diagnostic tooling. The trailer is only injected when
 * compression or Mem0 compaction actually reduced the token count.
 */

export interface CompressionTrailerMeta {
  mode: string;
  tokensBefore: number;
  tokensAfter: number;
}

export function buildCompressionTrailer(meta: CompressionTrailerMeta): string {
  const ratio = meta.tokensBefore > 0 ? (meta.tokensAfter / meta.tokensBefore).toFixed(2) : "1.00";
  return `: x-omniroute-compression: mode=${meta.mode}, ratio=${ratio}, tokens_before=${meta.tokensBefore}, tokens_after=${meta.tokensAfter}\n\n`;
}

export function createCompressionTrailerTransform(
  meta: CompressionTrailerMeta | null
): TransformStream<Uint8Array, Uint8Array> {
  if (!meta || meta.tokensBefore <= 0 || meta.tokensAfter >= meta.tokensBefore) {
    return new TransformStream();
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const trailer = buildCompressionTrailer(meta);
  let injected = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }
      const text = decoder.decode(chunk, { stream: true });
      const doneIdx = text.indexOf("data: [DONE]");
      if (doneIdx !== -1) {
        const before = text.slice(0, doneIdx);
        const after = text.slice(doneIdx);
        controller.enqueue(encoder.encode(before + trailer + after));
        injected = true;
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
