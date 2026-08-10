import { DOCUMENT, inject, Injectable } from "@angular/core";

/**
 * Reference-counted ownership of the app's body scroll lock.
 *
 * Shell drawers are independent component trees and may briefly overlap while one is closing or
 * while focus moves between them. A shared lease keeps one drawer from unlocking the page behind a
 * second, and the returned idempotent release function fits Angular effect cleanup so destruction
 * cannot strand the class on `<body>`.
 */
@Injectable({ providedIn: "root" })
export class BodyScrollLockService {
  private readonly document = inject(DOCUMENT);
  private leases = 0;

  acquire(): () => void {
    this.leases += 1;
    if (this.leases === 1) this.document.body.classList.add("k-no-scroll");

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases = Math.max(0, this.leases - 1);
      if (this.leases === 0) this.document.body.classList.remove("k-no-scroll");
    };
  }
}
