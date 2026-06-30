import type { DialogRef } from "@angular/cdk/dialog";
import { Dialog } from "@angular/cdk/dialog";
import { Injectable, inject } from "@angular/core";
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
      ariaLabel: initialImage?.fileName ? `Image preview: ${initialImage.fileName}` : "Image preview",
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
}
