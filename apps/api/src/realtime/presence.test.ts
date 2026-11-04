import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeRedis, getRedis, initRedis } from "../redis.js";
import { PresenceTracker, startPresenceReaper } from "./presence.js";

async function tracker() {
  await initRedis();
  await getRedis().flushdb();
  return new PresenceTracker();
}

void test("first socket for a user emits online once", async () => {
  const presence = await tracker();

  assert.deepEqual(await presence.markOnline("workspace-1", "user-1", "socket-1"), {
    workspaceId: "workspace-1",
    userId: "user-1",
    online: true,
  });
  assert.equal(await presence.markOnline("workspace-1", "user-1", "socket-1"), null);
});

void test("second socket does not duplicate online and last disconnect emits offline", async () => {
  const presence = await tracker();

  await presence.markOnline("workspace-1", "user-1", "socket-1");
  assert.equal(await presence.markOnline("workspace-1", "user-1", "socket-2"), null);
  assert.equal(await presence.markOffline("workspace-1", "user-1", "socket-1"), null);
  assert.deepEqual(await presence.markOffline("workspace-1", "user-1", "socket-2"), {
    workspaceId: "workspace-1",
    userId: "user-1",
    online: false,
  });
});

void test("disconnecting a socket removes all of its workspace presence", async () => {
  const presence = await tracker();
  await presence.markOnline("workspace-1", "user-1", "socket-1");
  await presence.markOnline("workspace-2", "user-1", "socket-1");

  assert.deepEqual(await presence.removeSocket("socket-1", "user-1"), [
    { workspaceId: "workspace-1", userId: "user-1", online: false },
    { workspaceId: "workspace-2", userId: "user-1", online: false },
  ]);
});

void test("snapshot contains currently online workspace users", async () => {
  const presence = await tracker();
  await presence.markOnline("workspace-1", "user-1", "socket-1");
  await presence.markOnline("workspace-1", "user-2", "socket-2");
  await presence.markOnline("workspace-2", "user-3", "socket-3");

  assert.deepEqual((await presence.onlineUserIds("workspace-1")).sort(), ["user-1", "user-2"]);
});

void test("stopping the reaper drains an in-flight offline notification", async () => {
  const presence = await tracker();
  // No heartbeat: this entry belongs to a dead process and must be reaped.
  await presence.markOnline("workspace-1", "user-1", "socket-1");
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stop = startPresenceReaper({
    emit: async () => {
      notifyStarted();
      await pending;
    },
  });
  try {
    await started;
    let stopped = false;
    const draining = Promise.resolve(stop()).then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, "shared resources must remain available to the offline notification");
    release();
    await draining;
    assert.equal(stopped, true);
    assert.deepEqual(await presence.onlineUserIds("workspace-1"), []);
  } finally {
    release();
    await stop();
  }
});

after(async () => {
  await closeRedis();
});
