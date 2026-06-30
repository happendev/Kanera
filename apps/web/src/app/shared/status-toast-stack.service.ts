import { Injectable, signal } from "@angular/core";

const DEFAULT_TOAST_HEIGHT = 44;
const TOAST_GAP_PX = 8;

type ToastEntry = {
  id: symbol;
  height: number;
};

@Injectable({ providedIn: "root" })
export class StatusToastStackService {
  private readonly entries = signal<ToastEntry[]>([]);

  register(id: symbol): void {
    this.entries.update((entries) => entries.some((entry) => entry.id === id) ? entries : [...entries, { id, height: DEFAULT_TOAST_HEIGHT }]);
  }

  unregister(id: symbol): void {
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id));
  }

  updateHeight(id: symbol, height: number): void {
    const measuredHeight = Math.max(DEFAULT_TOAST_HEIGHT, Math.ceil(height));
    this.entries.update((entries) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.height === measuredHeight) return entries;
      return entries.map((item) => item.id === id ? { ...item, height: measuredHeight } : item);
    });
  }

  bottomOffsetFor(id: symbol, baseOffsetPx: number): number {
    let offset = Math.max(0, baseOffsetPx);
    for (const entry of this.entries()) {
      if (entry.id === id) return offset;
      offset += entry.height + TOAST_GAP_PX;
    }
    return offset;
  }
}
