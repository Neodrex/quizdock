/** The console's `?team=` (the team picked in the run grid), as the control route reads it. */
export interface TeamSearch {
  team?: string;
}

/** Keeps a non-empty `team` string; anything else is dropped. */
export function validateTeamSearch(search: Record<string, unknown>): TeamSearch {
  return typeof search.team === 'string' && search.team ? { team: search.team } : {};
}
