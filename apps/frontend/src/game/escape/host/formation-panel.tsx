import type { EscapeHostOutline, EscapeHostState, EscapeTeams } from '@quiz-dock/contracts';
import { Users } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';

/** The team size the console aims for when it suggests a team count. */
const TEAM_SIZE = 5;
const MAX_TEAMS = 100;

/** Everyone in the room: in a team or not yet. */
export function playersIn(host: Pick<EscapeHostState, 'teams' | 'unassigned'>): number {
  return host.unassigned.length + host.teams.reduce((n, t) => n + t.members.length, 0);
}

/**
 * The suggested team count: teams of about five, and in roles mode no team smaller
 * than the room's role count (each player then holds one role), at least one team.
 */
export function suggestedCount(players: number, roleCount: number): number {
  const bySize = Math.ceil(players / TEAM_SIZE);
  const byRoles = roleCount > 0 ? Math.floor(players / roleCount) : bySize;
  return Math.min(MAX_TEAMS, Math.max(1, Math.min(bySize, byRoles)));
}

/** One name per line, trimmed, blank lines dropped, each cut to the server's 40. */
function namesOf(text: string): string[] {
  return text
    .split('\n')
    .map((n) => n.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, MAX_TEAMS);
}

/**
 * How the lobby's teams form (M5 Task 5.9): the host makes them (a count, an
 * optional cap and names), or opens a choice the players make on their phones.
 * Shown while forming only.
 */
export function FormationPanel({
  outline,
  host,
  onTeams,
  busy,
  maxTeams = MAX_TEAMS,
}: {
  outline: Pick<EscapeHostOutline, 'mode' | 'roles'>;
  host: EscapeHostState;
  onTeams: (p: Omit<EscapeTeams, 'pin'>) => Promise<unknown>;
  busy: boolean;
  /** The session type's ceiling (group play: 3). */
  maxTeams?: number;
}) {
  const { t } = useTranslation('escape');
  const id = useId();
  const [mode, setMode] = useState<EscapeTeams['mode']>(host.formation.mode);
  const [count, setCount] = useState<string | null>(null);
  const [maxSize, setMaxSize] = useState('');
  const [names, setNames] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (host.board.phase !== 'forming') return null;

  const players = playersIn(host);
  const roleCount = outline.mode === 'roles' ? outline.roles.length : 0;
  // Until the host types a count, it follows the room.
  const shownCount = count ?? String(Math.min(maxTeams, suggestedCount(players, roleCount)));
  const n = Number(shownCount);
  const cap = maxSize.trim() === '' ? undefined : Number(maxSize);
  const countOk = Number.isInteger(n) && n >= 1 && n <= maxTeams;
  const capOk = cap === undefined || (Number.isInteger(cap) && cap >= 1 && cap <= 50);
  const selfOpen = host.formation.mode === 'self' && host.formation.teams.length > 0;

  const submit = async () => {
    if (busy || !countOk || !capOk) return;
    setError(null);
    const list = namesOf(names).slice(0, maxTeams);
    try {
      await onTeams({
        mode,
        count: n,
        ...(cap !== undefined ? { maxSize: cap } : {}),
        ...(mode === 'auto' && list.length ? { names: list } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t('host.formation.title')}
        </h2>
        <span className="text-muted-foreground text-sm">
          {t('host.formation.players', { players })}
        </span>
      </div>
      <Segmented
        label={t('host.formation.mode')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'auto', label: t('host.formation.auto') },
          { value: 'self', label: t('host.formation.self') },
        ]}
        className="self-start [&>button]:min-h-11"
      />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-count`}>{t('host.formation.count')}</Label>
            <Input
              id={`${id}-count`}
              type="number"
              inputMode="numeric"
              min={1}
              max={maxTeams}
              value={shownCount}
              onChange={(e) => setCount(e.target.value)}
              aria-invalid={!countOk}
              className="min-h-11 text-base"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-max`}>{t('host.formation.maxSize')}</Label>
            <Input
              id={`${id}-max`}
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              value={maxSize}
              onChange={(e) => setMaxSize(e.target.value)}
              aria-invalid={!capOk}
              className="min-h-11 text-base"
            />
          </div>
        </div>
        {roleCount > 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('host.formation.rolesHint', { roles: roleCount })}
          </p>
        ) : null}
        {roleCount > 0 && cap !== undefined && capOk && cap < roleCount ? (
          <p className="text-warning-text text-sm">
            {t('host.formation.sharedRoles', { roles: roleCount })}
          </p>
        ) : null}
        {mode === 'auto' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-names`}>{t('host.formation.names')}</Label>
            <Textarea
              id={`${id}-names`}
              rows={3}
              value={names}
              onChange={(e) => setNames(e.target.value)}
              className="text-base"
            />
          </div>
        ) : null}
        <Button
          type="submit"
          size="lg"
          className="min-h-12 self-start"
          disabled={!countOk || !capOk}
          aria-busy={busy}
        >
          <Users className="size-4" aria-hidden />
          {mode === 'auto' ? t('host.formation.make') : t('host.formation.open')}
        </Button>
      </form>
      {selfOpen ? (
        <p role="status" className="text-sm font-medium">
          {t('host.formation.selfOpen')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
