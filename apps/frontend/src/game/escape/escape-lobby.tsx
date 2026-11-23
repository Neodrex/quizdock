import type { EscapePlayerState } from '@quiz-dock/contracts';
import { Check, Loader2, User, Users, WifiOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Avatar } from '../avatar';
import { loadPlayerSession } from '../game-client';
import { RaceCountdown } from './session/race-countdown';
import { RaceTeamCode, RaceTeamPicker } from './session/race-team-picker';

type Team = NonNullable<EscapePlayerState['team']>;

const noTeamRace = () => Promise.reject(new Error(''));

/**
 * Before the run, and whenever the phone has no team: who the player plays with.
 * Auto formation waits for the host; self formation lists the teams to pick from.
 * A race (M7) counts down to its scheduled start; a solo race says the player races
 * alone, and a team race offers solo, a new team or a team's code.
 */
export function EscapeLobby({
  state,
  me,
  chooseTeam,
  newTeam = noTeamRace,
  joinTeam = noTeamRace,
}: {
  state: EscapePlayerState;
  me: string | null;
  /** Rejects with the refusal's text (`escape.team_full`). */
  chooseTeam: (teamId: string) => Promise<void>;
  /** A team race: start a team, or join one by code. Reject with the refusal's text. */
  newTeam?: (name: string) => Promise<unknown>;
  joinTeam?: (code: string) => Promise<unknown>;
}) {
  const { t } = useTranslation('escape');
  const race = state.session?.type === 'race' ? state.session : null;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-center">
        <h1 className="text-[1.3em] font-bold">{state.title}</h1>
        {state.intro && <p className="text-muted-foreground">{state.intro}</p>}
      </div>
      {race && state.phase === 'forming' && race.startsAt !== null ? (
        <RaceCountdown startsAt={race.startsAt} className="text-center text-2xl" />
      ) : null}
      {race?.raceFormat === 'solo' ? (
        <p className="flex flex-col items-center gap-2 py-4 text-center">
          <User aria-hidden className="text-primary size-8" />
          <span className="text-lg font-semibold">{t('race.phone.alone')}</span>
        </p>
      ) : race?.raceFormat === 'teams' ? (
        state.team ? (
          <>
            <TeamCard team={state.team} me={me} />
            {state.team.code ? <RaceTeamCode code={state.team.code} /> : null}
          </>
        ) : (
          <RaceTeamPicker
            running={state.phase === 'running'}
            nickname={loadPlayerSession()?.nickname || t('race.phone.soloName')}
            newTeam={newTeam}
            joinTeam={joinTeam}
          />
        )
      ) : state.team ? (
        <TeamCard team={state.team} me={me} />
      ) : state.formation.mode === 'self' ? (
        <TeamChoice formation={state.formation} chooseTeam={chooseTeam} />
      ) : (
        <p className="flex flex-col items-center gap-3 py-6 text-center">
          <Loader2 aria-hidden className="text-primary size-8 animate-spin" />
          <span className="text-lg font-semibold">{t('lobby.waitingTeams')}</span>
        </p>
      )}
    </section>
  );
}

function TeamChoice({
  formation,
  chooseTeam,
}: {
  formation: EscapePlayerState['formation'];
  chooseTeam: (teamId: string) => Promise<void>;
}) {
  const { t } = useTranslation('escape');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set before the re-render: a double tap sends one request.
  const busy = useRef(false);
  const pick = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(id);
    setError(null);
    try {
      await chooseTeam(id);
    } catch (e) {
      setError((e as Error).message || t('lobby.chooseFailed'));
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const max = formation.maxSize;
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-semibold">{t('lobby.pickTeam')}</h2>
      <ul className="flex flex-col gap-2">
        {formation.teams.map((team) => {
          const full = max !== null && team.memberCount >= max;
          return (
            <li key={team.id}>
              <button
                type="button"
                disabled={full || pending !== null}
                aria-busy={pending === team.id || undefined}
                onClick={() => void pick(team.id)}
                className={cn(
                  'bg-card focus-visible:ring-ring flex min-h-12 w-full items-center gap-3 rounded-lg border px-4 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  'hover:bg-accent active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <Users aria-hidden className="text-muted-foreground size-5 shrink-0" />
                <span className="flex-1 font-medium">{team.name}</span>
                {pending === team.id && <Loader2 aria-hidden className="size-4 animate-spin" />}
                <span className="text-muted-foreground text-sm tabular-nums">
                  {max === null ? team.memberCount : `${team.memberCount}/${max}`}
                </span>
                {full && <span className="text-muted-foreground text-sm">{t('lobby.full')}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamCard({ team, me }: { team: Team; me: string | null }) {
  const { t } = useTranslation('escape');
  return (
    <div className="bg-card flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground text-sm">{t('lobby.yourTeam')}</span>
        <h2 className="text-lg font-bold">{team.name}</h2>
      </div>
      <ul aria-label={t('lobby.yourTeam')} className="flex flex-col gap-2">
        {team.members.map((m) => {
          const mine = m.playerId === me;
          return (
            <li
              key={m.playerId}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-md px-2',
                mine && 'bg-primary/10',
                !m.connected && 'opacity-60',
              )}
            >
              <Avatar name={m.nickname} size={36} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {m.nickname}
                {mine && (
                  <span className="text-muted-foreground font-normal"> {t('lobby.you')}</span>
                )}
              </span>
              {mine && <Check aria-hidden className="text-primary size-4" />}
              {!m.connected && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <WifiOff aria-hidden className="size-3.5" />
                  {t('lobby.offline')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
