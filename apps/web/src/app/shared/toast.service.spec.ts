import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastService, UNDO_WINDOW_MS } from "./toast.service";

// Exact timer boundaries and settlement/dismissal races cannot be scheduled reliably in E2E.
describe("promise toasts", () => {
  let service: ToastService;
  afterEach(() => {
    service?.ngOnDestroy();
    vi.useRealTimers();
  });

  it("keeps loading indefinitely and starts the full undo window on success", async () => {
    vi.useFakeTimers();
    service = new ToastService();
    let resolve!: (value: number) => void;
    const undo = vi.fn();
    const pending = service.promise(new Promise<number>((done) => { resolve = done; }), {
      loading: "Loading", success: (value) => `Saved ${value}`, error: "Failed", undo,
    });
    const id = service.messages()[0]!.id;
    vi.advanceTimersByTime(60_000);
    expect(service.messages()[0]).toMatchObject({ id, variant: "loading" });
    resolve(42);
    expect(await pending).toBe(42);
    expect(service.messages()[0]).toMatchObject({ id, variant: "success", message: "Saved 42" });
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(service.messages()).toHaveLength(1);
    service.messages()[0]!.action!.run();
    vi.advanceTimersByTime(1);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(service.messages()).toEqual([]);
  });

  it("keeps concurrent settlements separate and never resurrects a dismissed toast", async () => {
    vi.useFakeTimers();
    service = new ToastService();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const options = { loading: "Loading", success: "Saved", error: "Failed" };
    const first = service.promise(new Promise<void>((done) => { resolve = done; }), options);
    const second = service.promise(new Promise<void>((_, fail) => { reject = fail; }), options);
    const [one, two] = service.messages();
    service.dismiss(one!.id);
    resolve();
    await first;
    const error = new Error("original");
    reject(error);
    await expect(second).rejects.toBe(error);
    expect(service.messages()).toEqual([expect.objectContaining({ id: two!.id, variant: "error" })]);
    vi.advanceTimersByTime(5999);
    expect(service.messages()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(service.messages()).toEqual([]);
  });

  it("reports synchronous throws and ignores settlement after teardown", async () => {
    vi.useFakeTimers();
    service = new ToastService();
    const error = new Error("original");
    await expect(service.promise(() => { throw error; }, {
      loading: "Loading", success: "Saved", error: () => "Failed",
    })).rejects.toBe(error);
    expect(service.messages()[0]!.variant).toBe("error");
    let resolve!: () => void;
    const pending = service.promise(new Promise<void>((done) => { resolve = done; }), {
      loading: "Loading", success: "Saved", error: "Failed",
    });
    service.ngOnDestroy();
    resolve();
    await pending;
    expect(service.messages().at(-1)!.variant).toBe("loading");
    expect(vi.getTimerCount()).toBe(0);
  });
});
