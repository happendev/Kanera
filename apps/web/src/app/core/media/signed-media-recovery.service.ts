import { DOCUMENT } from "@angular/common";
import { Injectable, inject } from "@angular/core";
import { ApiClient } from "../api/api.client";

// Signed media URLs look like `<origin>/api/media/<clientId>/<key>?t=<token>&e=<expiry>`.
// We only attempt recovery for these; any other failing <img> is left alone.
const SIGNED_MEDIA_PATTERN = /\/api\/media\/[^?]+\?[^#]*\be=\d+/;

/**
 * Global, last-resort recovery for expired signed-media URLs.
 *
 * The backend now mints URLs with a long, overlapping validity window (see
 * media-signing.ts), so cached covers/thumbnails/avatars should not expire under
 * normal use. This service is defense-in-depth for the genuine edge cases — a tab
 * left open past the overlap window, signing-secret rotation, client clock skew —
 * so a stale URL self-heals instead of leaving a broken image.
 *
 * It installs a single capture-phase `error` listener on the document: image
 * `error` events do not bubble, so a capture-phase listener on a common ancestor
 * is the only way to observe them centrally without touching every render site.
 */
@Injectable({ providedIn: "root" })
export class SignedMediaRecoveryService {
  private readonly doc = inject(DOCUMENT);
  private readonly api = inject(ApiClient);

  init(): void {
    this.doc.addEventListener("error", this.onError, true);
  }

  private readonly onError = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const failed = target.currentSrc || target.src;
    if (!failed || !SIGNED_MEDIA_PATTERN.test(failed)) return;
    // One-shot guard: a re-signed URL that still fails (e.g. the object is truly
    // gone) must not loop forever firing `error` -> resign -> error.
    if (target.dataset["mediaRetried"]) return;
    target.dataset["mediaRetried"] = "1";
    void this.resign(target, failed);
  };

  private async resign(img: HTMLImageElement, failed: string): Promise<void> {
    try {
      const { url } = await this.api.get<{ url: string }>(`/media/resign?u=${encodeURIComponent(failed)}`);
      // For NgOptimizedImage (`[ngSrc]`) elements this swaps the native `src` as a
      // one-shot recovery; the directive's mutation check logs a dev-only console
      // warning, but production is unaffected and the image loads.
      img.src = url;
    } catch {
      // Leave the broken image in place; nothing more we can do for it.
    }
  }
}
