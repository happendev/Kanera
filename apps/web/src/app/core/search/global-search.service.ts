import { Injectable, effect, inject, signal } from "@angular/core";
import type { WireSearchResults } from "@kanera/shared/dto";
import { ApiClient } from "../api/api.client";

const DEBOUNCE_MS = 200; // 0.2 seconds

@Injectable({ providedIn: "root" })
export class GlobalSearchService {
  private readonly api = inject(ApiClient);

  readonly isOpen = signal(false);
  readonly query = signal("");
  readonly results = signal<WireSearchResults | null>(null);
  readonly loading = signal(false);

  // Monotonic request id so out-of-order responses from earlier keystrokes are dropped.
  private requestSeq = 0;

  constructor() {
    // Debounced fetch driven by the query signal while the overlay is open.
    effect((onCleanup) => {
      const q = this.query().trim();
      if (!this.isOpen()) return;
      if (q.length === 0) {
        // Invalidate any in-flight request and clear results.
        this.requestSeq++;
        this.results.set(null);
        this.loading.set(false);
        return;
      }
      this.loading.set(true);
      const handle = setTimeout(() => void this.run(q), DEBOUNCE_MS);
      onCleanup(() => clearTimeout(handle));
    });
  }

  open() {
    this.isOpen.set(true);
  }

  close() {
    this.isOpen.set(false);
    this.query.set("");
    this.results.set(null);
    this.loading.set(false);
    // Drop any in-flight response so it can't land after close.
    this.requestSeq++;
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private async run(q: string) {
    const seq = ++this.requestSeq;
    try {
      const res = await this.api.get<WireSearchResults>(`/search?q=${encodeURIComponent(q)}`);
      if (seq !== this.requestSeq) return; // a newer keystroke superseded this one
      this.results.set(res);
    } catch {
      if (seq !== this.requestSeq) return;
      this.results.set(null);
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
