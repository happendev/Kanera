import { Directive, ElementRef, HostListener, inject, input, type AfterViewInit } from "@angular/core";

const ITEM_SELECTOR = '.k-menu-item:not([disabled]):not([aria-disabled="true"])';

/**
 * Keyboard behaviour for every menu-shaped panel: arrow keys move between `.k-menu-item`s, Home/End
 * jump, typing a letter jumps to the next item starting with it, and focus lands on the first item
 * when the menu opens so the arrows work immediately. Apply alongside the `.k-menu` class; the
 * visual vocabulary lives in styles.scss so panels rendered from any component share one look.
 *
 * Escape and outside-click dismissal stay with kAnchoredPanel / the owning component: this directive
 * only owns what happens *inside* the menu.
 */
@Directive({
  selector: "[kMenu]",
  standalone: true,
  host: { class: "k-menu" },
})
export class MenuDirective implements AfterViewInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Set false for menus that open from a text field and must not steal its caret. */
  readonly kMenuAutofocus = input(true);
  private typeahead = "";
  private typeaheadTimer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    if (!this.kMenuAutofocus()) return;
    // Next frame: anchored panels position themselves after first paint, and focusing an element that
    // is still `visibility: hidden` is a no-op.
    requestAnimationFrame(() => {
      if (this.el.nativeElement.contains(document.activeElement)) return;
      this.items()[0]?.focus({ preventScroll: true });
    });
  }

  private items(): HTMLElement[] {
    return [...this.el.nativeElement.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
  }

  @HostListener("keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    const items = this.items();
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement || item.contains(document.activeElement));
    const focus = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown": return focus(current + 1);
      case "ArrowUp": return focus(current - 1);
      case "Home": return focus(0);
      case "End": return focus(items.length - 1);
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ") {
      this.typeahead += event.key.toLowerCase();
      if (this.typeaheadTimer) clearTimeout(this.typeaheadTimer);
      this.typeaheadTimer = setTimeout(() => (this.typeahead = ""), 600);
      const start = current + 1;
      for (let i = 0; i < items.length; i++) {
        const item = items[(start + i) % items.length];
        if (item.textContent?.trim().toLowerCase().startsWith(this.typeahead)) {
          focus(start + i);
          return;
        }
      }
    }
  }
}
