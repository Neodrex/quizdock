/**
 * Team formation (M3 plan §3, F1–F5): pure helpers over anything with an id and
 * members in join order. They never mutate their input.
 */

import { reassignRoles } from './escape-rules';
import type { EscapeTemplate, TeamState } from './escape.types';

export interface TeamSlot {
  id: string;
  name: string;
  members: string[];
}

type HasMembers = { id: string; members: string[] };

/** Teams t1…tN, named from `names` or `Team 1…`. */
export function makeTeams(count: number, names: string[] = []): TeamSlot[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: names[i] ?? `Team ${i + 1}`,
    members: [],
  }));
}

/** The id after every `t<n>` of `ids`: t1 for none (races add teams one at a time). */
export function nextTeamId(ids: readonly string[]): string {
  const ns = ids.map((id) => /^t(\d+)$/.exec(id)).map((m) => (m ? Number(m[1]) : 0));
  return `t${Math.max(0, ...ns) + 1}`;
}

/** The team with the fewest members (earlier on ties) below `maxSize` (0 or absent: no cap). */
export function smallestTeam<T extends HasMembers>(teams: T[], maxSize = 0): T | null {
  let best: T | null = null;
  for (const t of teams) {
    if (maxSize && t.members.length >= maxSize) continue;
    if (!best || t.members.length < best.members.length) best = t;
  }
  return best;
}

export function teamOf<T extends HasMembers>(teams: T[], playerId: string): T | null {
  return teams.find((t) => t.members.includes(playerId)) ?? null;
}

/** F1: each player, in join order, to the smallest team; players already in a team stay. */
export function dealPlayers<T extends HasMembers>(teams: T[], playerIds: string[]): T[] {
  let out = teams;
  for (const id of playerIds) {
    if (teamOf(out, id)) continue;
    const to = smallestTeam(out);
    if (!to) break;
    out = out.map((t) => (t === to ? { ...t, members: [...t.members, id] } : t));
  }
  return out;
}

/**
 * Moves a player to the end of `toTeamId`'s members, or out of every team with
 * null. The same team, or an unknown one, gives back `teams` itself.
 */
export function moveMember<T extends HasMembers>(
  teams: T[],
  playerId: string,
  toTeamId: string | null,
): T[] {
  const from = teamOf(teams, playerId);
  if ((from?.id ?? null) === toTeamId) return teams;
  if (toTeamId !== null && !teams.some((t) => t.id === toTeamId)) return teams;
  return teams.map((t) => {
    if (t === from) return { ...t, members: t.members.filter((m) => m !== playerId) };
    if (t.id === toTeamId) return { ...t, members: [...t.members, playerId] };
    return t;
  });
}

/**
 * F4: the team's roles for its connected members, in team order (sticky, see
 * reassignRoles). Parallel mode has no roles.
 */
export function rolesFor(
  tpl: EscapeTemplate,
  team: TeamState,
  connected: ReadonlySet<string>,
): Record<string, string[]> {
  if (tpl.mode !== 'roles') return {};
  return reassignRoles(
    team.roles,
    team.members.filter((m) => connected.has(m)),
    tpl.roles.map((r) => r.id),
  );
}
