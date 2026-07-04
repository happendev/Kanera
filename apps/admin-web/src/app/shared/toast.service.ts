import { Injectable, signal } from "@angular/core";

export interface Toast {
  id: number;
  message: string;
  kind: "success" | "error";
}

// Minimal local toast stack — deliberately not cross-imported from @kanera/web (the admin app keeps its
// own dependency-light copy so the two apps stay decoupled).
@Injectable({ providedIn: "root" })
export class ToastService {
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);

  private push(message: string, kind: Toast["kind"]): void {
    const id = this.nextId++;
    this.toasts.update((t) => [...t, { id, message, kind }]);
    setTimeout(() => this.dismiss(id), 4000);
  }

  success(message: string): void {
    this.push(message, "success");
  }

  error(message: string): void {
    this.push(message, "error");
  }

  dismiss(id: number): void {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
