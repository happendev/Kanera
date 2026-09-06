import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { SocketService } from "../core/realtime/socket.service";
import { ToastComponent } from "./toast.component";

@Component({
  selector: "k-disconnect-prompt",
  standalone: true,
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-toast [show]="sockets.accessRefreshing() || !sockets.displayedOnline()" [icon]="icon()" [message]="message()" />
  `,
})
export class DisconnectPromptComponent {
  readonly sockets = inject(SocketService);
  readonly icon = computed(() => this.sockets.accessRefreshing() ? "user-shield" : "wifi-off");
  readonly message = computed(() => {
    if (this.sockets.accessRefreshing()) return "Updating permissions...";
    return this.sockets.reconnecting() ? "You're offline - reconnecting..." : "Disconnected - retrying...";
  });
}
