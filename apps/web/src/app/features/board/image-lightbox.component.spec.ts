import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloadService } from "../../core/media/media-download.service";
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
    const download = vi.fn<MediaDownloadService["download"]>(() => Promise.resolve());
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
        { provide: MediaDownloadService, useValue: { download } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();

    await fixture.componentInstance.downloadActiveImage();

    expect(download).toHaveBeenCalledWith(
      "https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.png?t=token&e=9999999999999",
      "Design proof.png",
    );
  });

  it("renders video media with native playback controls instead of image zoom controls", () => {
    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://example.com/walkthrough.mp4",
            fileName: "walkthrough.mp4",
            mediaType: "video",
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const video = host.querySelector("video");
    expect(video?.src).toBe("https://example.com/walkthrough.mp4");
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(true);
    expect(host.querySelector("img.lb-img")).toBeNull();
    expect(host.querySelector('[aria-label="Zoom in"]')).toBeNull();
  });

  it("renders audio attachments with native playback controls", () => {
    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://example.com/recording.mp3",
            fileName: "recording.mp3",
            mediaType: "audio",
            mimeType: "audio/*",
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();

    const audio = (fixture.nativeElement as HTMLElement).querySelector("audio");
    expect(audio?.src).toBe("https://example.com/recording.mp3");
    expect(audio?.controls).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Zoom in"]')).toBeNull();
  });

  it("fetches PDFs into a blob URL for native iframe preview", async () => {
    const pdfUrl = "https://api.test/api/media/client-1/cards/card-1/brief.pdf?t=token&e=9999999999999";
    const pdfBlob = new Blob(["pdf"], { type: "application/pdf" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      blob: () => Promise.resolve(pdfBlob),
    })));
    // about:blank avoids jsdom navigating an iframe to an opaque blob origin; production receives
    // a real blob URL from the browser.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("about:blank");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: pdfUrl,
            fileName: "Project brief.pdf",
            mediaType: "pdf",
            mimeType: "application/pdf",
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector("iframe.lb-pdf")).not.toBeNull();
    });

    expect(fetch).toHaveBeenCalledWith(pdfUrl, { signal: expect.any(AbortSignal) });
    expect(URL.createObjectURL).toHaveBeenCalledWith(pdfBlob);
    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("about:blank");
  });

  it("fetches and renders Markdown attachments as sanitized rich content", async () => {
    const markdownUrl = "https://api.test/api/media/client-1/cards/card-1/plan.md?t=token&e=9999999999999";
    const markdown = "# Agent plan\n\n- Inspect inputs\n- Ship output\n\n<script>alert('no')</script>";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      blob: () => Promise.resolve({
        size: markdown.length,
        text: () => Promise.resolve(markdown),
      }),
    })));

    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: markdownUrl,
            fileName: "plan.md",
            mediaType: "markdown",
            mimeType: "text/markdown",
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector(".lb-markdown h1")?.textContent).toBe("Agent plan");
    });

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll(".lb-markdown li")).toHaveLength(2);
    expect(host.querySelector(".lb-markdown script")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(markdownUrl, { signal: expect.any(AbortSignal) });
  });

  it("loads a PDF reached through gallery navigation and aborts it when navigating away", async () => {
    let resolvePdf!: (response: Response) => void;
    let resolvePdfBlob!: (blob: Blob) => void;
    const pdfBlob = new Blob(["pdf"], { type: "application/pdf" });
    const pdfBlobPromise = new Promise<Blob>((resolve) => {
      resolvePdfBlob = resolve;
    });
    const readPdfBlob = vi.fn(() => pdfBlobPromise);
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>((resolve) => {
      resolvePdf = resolve;
    }));
    vi.stubGlobal("fetch", fetch);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("about:blank");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://example.com/image.png",
            images: [
              { src: "https://example.com/image.png", fileName: "image.png", mediaType: "image" },
              { src: "https://example.com/brief.pdf", fileName: "brief.pdf", mediaType: "pdf" },
            ],
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    await fixture.whenStable();
    expect(fetch).not.toHaveBeenCalled();

    fixture.componentInstance.showNext();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = fetch.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);

    resolvePdf({ ok: true, blob: readPdfBlob } as unknown as Response);
    await vi.waitFor(() => expect(readPdfBlob).toHaveBeenCalledTimes(1));

    fixture.componentInstance.showPrevious();
    await fixture.whenStable();
    expect(signal.aborted).toBe(true);

    // Finish the response body after cancellation so the stale async load runs its guard before
    // this test restores the URL mocks. Compare against the call count at the abort boundary: URL
    // is a shared browser global, so a full release run can include calls from another fixture.
    const objectUrlCallsAtAbort = createObjectUrl.mock.calls.length;
    resolvePdfBlob(pdfBlob);
    await pdfBlobPromise;
    await Promise.resolve();
    expect(fixture.componentInstance.pdfSrc()).toBeNull();
    expect(createObjectUrl).toHaveBeenCalledTimes(objectUrlCallsAtAbort);
  });

  it("navigates across image, video, audio, and PDF attachments", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      new Blob(["pdf"], { type: "application/pdf" }),
    ))));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("about:blank");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DIALOG_DATA,
          useValue: {
            src: "https://example.com/image.png",
            images: [
              { src: "https://example.com/image.png", mediaType: "image" },
              { src: "https://example.com/video.mp4", mediaType: "video" },
              { src: "https://example.com/audio.mp3", mediaType: "audio" },
              { src: "https://example.com/file.pdf", mediaType: "pdf" },
            ],
          },
        },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(ImageLightboxComponent);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector("img.lb-img")).not.toBeNull();

    fixture.componentInstance.showNext();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector("video.lb-video")).not.toBeNull();

    fixture.componentInstance.showNext();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector("audio")).not.toBeNull();

    fixture.componentInstance.showNext();
    await vi.waitFor(() => expect((fixture.nativeElement as HTMLElement).querySelector("iframe.lb-pdf")).not.toBeNull());
    expect(fixture.componentInstance.positionLabel()).toBe("4 / 4");
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Previous attachment"]')).not.toBeNull();
  });
});
