import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { LogoComponent } from "../../shared/logo.component";

/**
 * Landing page for the unsubscribe link in lifecycle (onboarding and account-tip) emails. It needs no
 * session: the signed token in the link is the only authority. Unsubscribing takes an explicit click
 * so inbox link scanners that prefetch URLs cannot opt someone out.
 */
@Component({
  selector: "k-email-unsubscribe",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./email-unsubscribe.page.html",
  styleUrls: ["../auth/login.page.scss", "./email-unsubscribe.page.scss"],
})
export class EmailUnsubscribePage {
  private readonly publicAuth = inject(PublicAuthClient);
  readonly token = input<string | null>(null);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<string | null>(null);

  async unsubscribe(event: Event) {
    event.preventDefault();
    const token = this.token();
    if (!token) {
      this.error.set("This unsubscribe link is missing its token. Use the link from the email.");
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.publicAuth.post("/email/unsubscribe", { token });
      if (!res.ok) {
        this.error.set("This unsubscribe link is invalid. You can turn these emails off under Settings, then Notifications.");
        return;
      }
      this.done.set(true);
    } catch {
      this.error.set("We couldn't reach Kanera. Check your connection and try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
