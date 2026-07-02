import { afterEach, describe, expect, it, vi } from "vitest";
import { suppressDropCommitTransitions } from "./drop-commit-transition";

describe("suppressDropCommitTransitions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deduplicates a same-list container and removes the class after two frames", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const container = document.createElement("div");

    suppressDropCommitTransitions(container, container);

    expect(container.classList.contains("is-drop-committing")).toBe(true);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(container.classList.contains("is-drop-committing")).toBe(true);
    frames.shift()?.(16);
    expect(container.classList.contains("is-drop-committing")).toBe(false);
  });

  it("marks both source and target containers for a cross-list drop", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const source = document.createElement("div");
    const target = document.createElement("div");

    suppressDropCommitTransitions(source, target);

    expect(source.classList.contains("is-drop-committing")).toBe(true);
    expect(target.classList.contains("is-drop-committing")).toBe(true);
  });
});
