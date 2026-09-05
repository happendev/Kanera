import type { OnDestroy } from "@angular/core";
import { Injectable, signal } from "@angular/core";

@Injectable({ providedIn: "root" })
export class ActionToastService implements OnDestroy {
  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly messages = signal<{ id: number; message: string; icon: string }[]>([]);

  // Application ownership keeps confirmations alive after a menu or card drawer closes.
  success(message: string, icon: string) {
    const id = ++this.nextId;
    this.messages.update((messages) => [...messages, { id, message, icon }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), 6000));
  }

  dismiss(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.messages.update((messages) => messages.filter((message) => message.id !== id));
  }

  ngOnDestroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
  }
}
