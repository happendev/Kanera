/** Copies text to the clipboard where the API exists; silently a no-op in non-browser or insecure contexts. */
export async function copyToClipboard(value: string): Promise<void> {
  if (typeof navigator === "undefined") return;
  await navigator.clipboard?.writeText(value);
}
