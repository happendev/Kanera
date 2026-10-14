import type { DialogRef } from "@angular/cdk/dialog";
import { Dialog } from "@angular/cdk/dialog";
import { Injectable, inject } from "@angular/core";
import { icu } from "../../core/i18n/icu";
import { ImageLightboxComponent, type ImageLightboxData } from "./image-lightbox.component";

@Injectable({ providedIn: "root" })
export class ImageLightboxService {
  private readonly dialog = inject(Dialog);
  private ref: DialogRef<unknown, ImageLightboxComponent> | null = null;

  open(data: ImageLightboxData, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();

    this.ref?.close();

    const initialImage = data.images?.length
      ? data.images[Math.min(Math.max(data.initialIndex ?? 0, 0), data.images.length - 1)]
      : data;

    const ref = this.dialog.open(ImageLightboxComponent, {
      ariaLabel: this.ariaLabel(initialImage?.mediaType, initialImage?.fileName),
      backdropClass: "lb-cdk-backdrop",
      panelClass: "lb-cdk-panel",
      width: "100vw",
      height: "100vh",
      maxWidth: "100vw",
      maxHeight: "100vh",
      data,
    });

    this.ref = ref;
    ref.closed.subscribe(() => {
      if (this.ref === ref) this.ref = null;
    });
  }

  private ariaLabel(mediaType: ImageLightboxData["mediaType"], fileName: string | null | undefined): string {
    // One select per media type so each language can inflect "preview" with its own word order.
    const kind = mediaType === "video" || mediaType === "audio" || mediaType === "pdf" || mediaType === "markdown" ? mediaType : "image";
    return fileName
      ? icu(
          $localize`:Dialog label for a file preview; fileName is the attachment name:{kind, select, video {Video preview: {fileName}} audio {Audio preview: {fileName}} pdf {PDF preview: {fileName}} markdown {Markdown preview: {fileName}} other {Image preview: {fileName}}}`,
          { kind, fileName },
        )
      : icu(
          $localize`:Dialog label for a file preview:{kind, select, video {Video preview} audio {Audio preview} pdf {PDF preview} markdown {Markdown preview} other {Image preview}}`,
          { kind },
        );
  }
}
