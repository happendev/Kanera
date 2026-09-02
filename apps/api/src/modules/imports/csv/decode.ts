export interface DecodedCsv {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
}

export function decodeCsvBuffer(buffer: Buffer): DecodedCsv {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // A UTF-8 BOM is a strong hint, not a guarantee: pasted cp1252 bytes after it must not 500.
    return decodeUtf8OrWindows1252(buffer.subarray(3));
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "utf-16be" };
  }

  const sampleLength = Math.min(buffer.length, 2_000);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }
  const pairs = Math.max(1, Math.floor(sampleLength / 2));
  if (oddNuls / pairs > 0.2 && evenNuls / pairs < 0.05) {
    return { text: new TextDecoder("utf-16le").decode(buffer), encoding: "utf-16le" };
  }
  if (evenNuls / pairs > 0.2 && oddNuls / pairs < 0.05) {
    return { text: new TextDecoder("utf-16be").decode(buffer), encoding: "utf-16be" };
  }

  return decodeUtf8OrWindows1252(buffer);
}

function decodeUtf8OrWindows1252(bytes: Uint8Array): DecodedCsv {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}
