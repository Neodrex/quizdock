import {
  ESCAPE_TOOLS,
  type EscapeHostSession,
  type EscapeTool,
  toolsOf,
} from '@quiz-dock/contracts';

/** The host tools a console shows: a set, read with `can`. */
export type ToolSet = ReadonlySet<EscapeTool>;

/**
 * What the console shows for the room's session (M7 §1.1): the server's own list
 * (`session.tools`), else the shared table for its type. A room opened before
 * session types is hosted: every tool. The server stays the authority; this only
 * hides what it would refuse.
 */
export function toolsFor(session: Pick<EscapeHostSession, 'type' | 'tools'> | null): ToolSet {
  if (!session) return new Set(ESCAPE_TOOLS);
  return new Set(session.tools.length ? session.tools : toolsOf(session.type));
}

/** No set: every tool (the M5 console, and the components' own tests). */
export const can = (tools: ToolSet | undefined, tool: EscapeTool): boolean =>
  !tools || tools.has(tool);

/** Group play forms at most 3 teams (M7 §1.1); the others, as M5. */
export function maxTeamsFor(session: Pick<EscapeHostSession, 'type'> | null): number | undefined {
  return session?.type === 'group' ? 3 : undefined;
}

/** Seats taken of the cap (owner question 3); full when no seat is left. */
export function seatsOf(session: Pick<EscapeHostSession, 'cap' | 'joined'>): {
  joined: number;
  cap: number;
  full: boolean;
} {
  return { joined: session.joined, cap: session.cap, full: session.joined >= session.cap };
}
