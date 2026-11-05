import type { Signal } from "@angular/core";
import { Injectable, computed, signal } from "@angular/core";

type ShellNavSource = {
  /** True while the sidebar is an off-canvas drawer with no rail beside the page (phones). */
  drawerMode: Signal<boolean>;
  /** Something in Up next is overdue: the one drawer state the menu button marks with a dot. */
  overdue: Signal<boolean>;
  /** The drawer button's accessible name; the shell's own sidebar toggle string, so both match. */
  label: string;
  open: () => void;
  unreadNotifications: Signal<number>;
  /** The drawer bell's own accessible name, unread count included, so both triggers read alike. */
  notificationsLabel: Signal<string>;
  openNotifications: () => void;
};

/**
 * The bridge between the app shell, which owns the navigation drawer, and the page header, which
 * holds the button that opens it on phones.
 *
 * Phones have no sidebar rail (app-shell.component.scss, the 640px block), so the drawer's trigger
 * lives at the start of every page's header instead of in shell chrome that would cost each page a
 * column. The shell connects itself here; headers read it. Outside the shell (or before it connects)
 * nothing is connected, and headers show no button.
 */
@Injectable({ providedIn: "root" })
export class ShellNavService {
  private readonly source = signal<ShellNavSource | null>(null);
  private readonly triggers = signal(0);

  readonly drawerMode = computed(() => this.source()?.drawerMode() ?? false);
  readonly overdue = computed(() => this.source()?.overdue() ?? false);
  readonly label = computed(() => this.source()?.label ?? "");
  readonly unreadNotifications = computed(() => this.source()?.unreadNotifications() ?? 0);
  readonly notificationsLabel = computed(() => this.source()?.notificationsLabel() ?? "");
  /**
   * Whether a page header on screen carries the drawer button. The shell shows its own fallback
   * button while none does, so a page that renders no header (or not yet) never strands the user
   * without navigation.
   */
  readonly hasHeaderTrigger = computed(() => this.triggers() > 0);

  connect(source: ShellNavSource): () => void {
    this.source.set(source);
    return () => {
      if (this.source() === source) this.source.set(null);
    };
  }

  /** Called by each page header for its lifetime; the returned function releases it. */
  registerTrigger(): () => void {
    this.triggers.update((count) => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.triggers.update((count) => Math.max(0, count - 1));
    };
  }

  open(): void {
    this.source()?.open();
  }

  openNotifications(): void {
    this.source()?.openNotifications();
  }
}
