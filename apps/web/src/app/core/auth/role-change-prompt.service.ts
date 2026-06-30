import { Injectable, inject, signal } from "@angular/core";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { registerSocketHandlers } from "../realtime/socket-handlers";
import { SocketService } from "../realtime/socket.service";
import { AuthService } from "./auth.service";

@Injectable({ providedIn: "root" })
export class RoleChangePromptService {
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);

  readonly refreshRequired = signal(false);

  constructor() {
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      [SERVER_EVENTS.CLIENT_USER_ROLE_CHANGED]: ({ userId }) => {
        if (userId === this.auth.user()?.id) this.refreshRequired.set(true);
      },
      [SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED]: ({ member }) => {
        if (member.userId === this.auth.user()?.id) this.refreshRequired.set(true);
      },
    };

    registerSocketHandlers(socket, handlers);
  }
}
