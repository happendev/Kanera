import { Injectable } from "@angular/core";

@Injectable({ providedIn: "root" })
export class MediaDownloadService {
  async download(url: string, fileName: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Media download failed with status ${response.status}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        this.trigger(objectUrl, fileName);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      // A direct navigation still lets the browser download media when a signed URL cannot be
      // fetched as a blob (for example because of cross-origin policy or transient fetch failure).
      this.trigger(url, fileName);
    }
  }

  private trigger(url: string, fileName: string): void {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  }
}
