import { renderSVG } from "uqr";

export function mfaQrDataUrl(otpauthUri: string): string {
  // A four-module quiet zone and medium error correction keep authenticator scanning reliable
  // without embedding the sensitive otpauth URI as readable text in the SVG.
  const svg = renderSVG(otpauthUri, { border: 4, ecc: "M" });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
