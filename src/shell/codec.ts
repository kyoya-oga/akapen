export const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  const collectChunks = (offset: number): void => {
    if (offset >= bytes.length) {
      return;
    }
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    chunks.push(String.fromCharCode(...slice));
    collectChunks(offset + chunkSize);
  };
  collectChunks(0);
  return btoa(chunks.join(""));
};

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  Array.from({ length: binary.length }).map((_, i) => {
    bytes[i] = binary.charCodeAt(i);
  });
  return bytes;
};

export const compressStringGzipBase64 = async (text: string): Promise<string> => {
  const rawBytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") {
    return uint8ArrayToBase64(rawBytes);
  }
  const stream = new Blob([rawBytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const compressedBuffer = await new Response(stream).arrayBuffer();
  return uint8ArrayToBase64(new Uint8Array(compressedBuffer));
};

export const decompressGzipBase64ToString = async (base64: string): Promise<string> => {
  const bytes = base64ToUint8Array(base64);
  if (typeof DecompressionStream === "undefined") {
    return new TextDecoder().decode(bytes);
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return new TextDecoder().decode(bytes);
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const decompressedBuffer = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(decompressedBuffer);
};

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document === "undefined" || document.body === null) {
    return false;
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("style", "position:fixed;left:-9999px;top:-9999px;");
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
};
