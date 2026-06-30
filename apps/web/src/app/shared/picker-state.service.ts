import { Injectable, signal } from "@angular/core";

/**
 * Tracks which picker (color or icon) is currently open across the page.
 * Each picker registers its unique instance ID when it opens; all other
 * instances watch this signal and close themselves automatically.
 */
@Injectable({ providedIn: "root" })
export class PickerStateService {
  readonly activeId = signal<string | null>(null);

  open(id: string): void {
    this.activeId.set(id);
  }
}
