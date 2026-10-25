import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";
import { OfflineCacheService } from "./offline-cache.service";
import { CachedViewService } from "./cached-view.service";

// Failure mode: a slow pre-refresh response arrives after a newer response and overwrites the
// offline copy, even though the component correctly ignores it. Control promise ordering here;
// a browser run cannot reliably arrange that race between a realtime refresh and an HTTP read.
it("keeps the newest query response cached when an older request finishes last", async () => {
  let finishOld!: (response: object) => void;
  const api = { get: vi.fn()
    .mockImplementationOnce(() => new Promise<object>((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ events: ["latest"] }) };
  const cache = { saveViewQuery: vi.fn().mockResolvedValue(undefined) };
  TestBed.configureTestingModule({ providers: [
    { provide: ApiClient, useValue: api },
    { provide: AuthService, useValue: { user: signal({ id: "viewer", clientId: "original", activeClientId: "current" }) } },
    { provide: SocketService, useValue: { online: signal(true) } },
    { provide: OfflineCacheService, useValue: cache },
  ] });
  const queries = TestBed.inject(CachedViewService);
  const old = queries.read({ url: "/boards/one/work-done?from=today" });
  await queries.read({ url: "/boards/one/work-done?from=today" });
  finishOld({ events: ["old"] });
  await old;
  expect(cache.saveViewQuery).toHaveBeenCalledTimes(1);
  expect(cache.saveViewQuery).toHaveBeenCalledWith(expect.stringContaining("current:viewer:"), { events: ["latest"] });
});
