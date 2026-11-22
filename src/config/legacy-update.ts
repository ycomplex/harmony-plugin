/** B-1501: the one line printed when a save updated, in place, a stored entry saved before project ids
 *  were recorded (`updatedLegacyFor` from saveProject). Such an entry cannot be told apart from another
 *  project of the same name on the same backend, so the overwrite is made visible. Names only. Shared by
 *  `harmony login` / `project adopt-settings-token` and the download commands. */
export function legacyUpdateLine(key: string, projectId: string): string {
  return `Updated the entry "${key}" in place: it was saved before project ids were recorded, and it now holds project ${projectId}.`;
}
