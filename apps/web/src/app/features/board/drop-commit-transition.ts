const DROP_COMMITTING_CLASS = "is-drop-committing";

/**
 * Prevent CDK's displaced-sibling transform from being animated after the drop order commits.
 * Angular reorders tracked nodes while CDK's removed transform may still be transitioning; without
 * this guard the layout displacement and stale transform are briefly applied at the same time.
 */
export function suppressDropCommitTransitions(source: HTMLElement | undefined, target: HTMLElement | undefined): void {
  const containers = [...new Set([source, target].filter((element): element is HTMLElement => element !== undefined))];

  for (const container of containers) container.classList.add(DROP_COMMITTING_CLASS);
  // Flush after transition suppression is active, before Angular commits its optimistic DOM order.
  for (const container of containers) void container.offsetWidth;

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      for (const container of containers) container.classList.remove(DROP_COMMITTING_CLASS);
    });
  });
}
