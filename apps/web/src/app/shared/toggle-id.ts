/** Adds `id` to the list or removes it when already present; order of the remaining ids is kept. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}
