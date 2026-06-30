import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightboxComponent } from "./image-lightbox.component";

describe("ImageLightboxComponent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cycles through gallery images and resets zoom when the image changes", () => {
    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://example.com/first.png",
            images: [
              { src: "https://example.com/first.png", fileName: "first.png" },
              { src: "https://example.com/second.png", fileName: "second.png" },
            ],
            initialIndex: 1,
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.activeImage().fileName).toBe("second.png");

    fixture.componentInstance.zoomIn();
    expect(fixture.componentInstance.scale()).toBe(1.5);

    fixture.componentInstance.showNext();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeImage().fileName).toBe("first.png");
    expect(fixture.componentInstance.scale()).toBe(1);

    fixture.componentInstance.showPrevious();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeImage().fileName).toBe("second.png");
  });

  it("downloads the active image with its stored file name", async () => {
    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.png?t=token&e=9999999999999",
            fileName: "Design proof.png",
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();

    const blob = new Blob(["image"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(blob) })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:lightbox-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let anchor: HTMLAnchorElement | null = null;
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") anchor = element as HTMLAnchorElement;
      return element;
    });

    await fixture.componentInstance.downloadActiveImage();

    expect(fetch).toHaveBeenCalledWith("https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.png?t=token&e=9999999999999");
    const downloadAnchor = anchor as HTMLAnchorElement | null;
    expect(downloadAnchor?.href).toBe("blob:lightbox-download");
    expect(downloadAnchor?.download).toBe("Design proof.png");
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:lightbox-download");
  });
});
