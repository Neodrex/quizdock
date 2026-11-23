import type { EscapePlayerState } from '@quiz-dock/contracts';
import { Link } from '@tanstack/react-router';
import { Hourglass, Loader2, PartyPopper, UserRoundX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { ClueList } from '../game/escape/clue-list';
import { EscapeAnnouncer } from '../game/escape/escape-announcer';
import { EscapeFinaleView } from '../game/escape/escape-finale';
import { EscapeLobby } from '../game/escape/escape-lobby';
import { loadEscapeRecord } from '../game/escape/escape-record';
import { HintPanel } from '../game/escape/hint-panel';
import { usePhoneHost } from '../game/escape/host/use-phone-host';
import { BrandBand } from '../game/escape/session/brand-band';
import { blockOf, LockList } from '../game/escape/locks/lock-list';
import { ProgressDots } from '../game/escape/progress-dots';
import { RoleCard } from '../game/escape/role-card';
import { PhoneHostBar } from '../game/escape/session/phone-host-bar';
import { TeamTimer, formatClock } from '../game/escape/team-timer';
import { STAGE_TITLE_ID, UnlockMoment } from '../game/escape/unlock-moment';
import type { EscapeSession } from '../game/escape/use-escape-session';
import { useTeamClock } from '../game/escape/use-team-clock';
import { LiveTheme } from '../game/theme';

/**
 * A phone in an escape run (`PlayerView` hands over here while escape mode is on):
 * the lobby, the team's stage, its end, then the finale. It draws only what the
 * phone is sent; the host leaving does not stop the team (§1.1).
 */
export function EscapePlayer({
  pin,
  escape,
  me,
  connectionLost,
  hostAway,
}: {
  pin: string;
  escape: EscapeSession;
  /** This phone's player id. */
  me: string | null;
  connectionLost: boolean;
  /** The quiz session says HOST_DISCONNECTED: a note, play goes on. */
  hostAway: boolean;
}) {
  const { t } = useTranslation('escape');
  const { ui, dispatch } = escape;
  const state = ui.state;
  const team = state?.team ?? null;
  const clock = useTeamClock(
    {
      deadlineAt: team?.deadlineAt ?? null,
      remainingMs: team?.remainingMs ?? 0,
      paused: !!state?.clock.paused,
    },
    (minutes) => dispatch({ type: 'clockWarning', minutes }),
  );

  // The last stage's unlock text, as this phone saw the escape.
  const [lastUnlock, setLastUnlock] = useState<string | null>(null);
  if (ui.overlay?.kind === 'escaped' && ui.overlay.unlockText !== lastUnlock) {
    setLastUnlock(ui.overlay.unlockText);
  }

  const myTeamId = team?.id ?? loadEscapeRecord(pin)?.teamId ?? null;
  // Group play: this phone also hosts (M7 owner question 1).
  const isPhoneHost = !!state?.session?.isPhoneHost;
  const phoneHost = usePhoneHost(pin, isPhoneHost);

  let screen: React.ReactNode;
  if (ui.finale) {
    screen = (
      <EscapeFinaleView finale={ui.finale} myTeamId={myTeamId} closed={ui.ended === 'final'} />
    );
  } else if (ui.ended === 'waiting' || (state?.phase === 'finale' && ui.ended === 'none')) {
    screen = <Waiting text={t('end.resultsComing')} />;
  } else if (ui.ended === 'final') {
    screen = (
      <section className="my-auto flex flex-col items-center gap-4 text-center">
        <p className="text-xl font-semibold">{t('end.over')}</p>
        <Link to="/join" className={cn(buttonVariants({ size: 'lg' }), 'min-h-12 w-full')}>
          {t('finale.joinAnother')}
        </Link>
      </section>
    );
  } else if (!state) {
    screen = <Waiting text={t('end.loading')} />;
  } else if (state.phase === 'forming' || !team) {
    screen = (
      <EscapeLobby
        state={state}
        me={me}
        chooseTeam={escape.chooseTeam}
        newTeam={escape.newTeam}
        joinTeam={escape.joinTeam}
      />
    );
  } else if (team.escaped) {
    screen = (
      <EscapedView
        state={state}
        unlockText={lastUnlock}
        timeMs={team.escapedMs ?? state.clock.elapsedMs}
      />
    );
  } else if (team.timedOut) {
    screen = <TimeUpView state={state} />;
  } else {
    const block = blockOf(state, connectionLost);
    screen = (
      <>
        <header className="bg-background/95 sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b px-4 py-2">
          <TeamTimer remainingMs={clock.remainingMs} paused={clock.paused} />
          <ProgressDots stageIndex={team.stageIndex} stageCount={team.stageCount} />
          <span className="min-w-0 flex-1 truncate text-right text-sm font-medium">
            {team.name}
          </span>
        </header>
        {state.view && (
          <>
            <div className="flex flex-col gap-1">
              <h2
                id={STAGE_TITLE_ID}
                tabIndex={-1}
                className="text-[1.3em] font-bold focus:outline-none"
              >
                {state.view.title}
              </h2>
              {state.view.intro && (
                <div className="text-muted-foreground">
                  <Markdown>{state.view.intro}</Markdown>
                </div>
              )}
            </div>
            <RoleCard state={state} me={me} />
            <ClueList view={state.view} roles={state.roles} />
            <LockList view={state.view} roles={state.roles} block={block} submit={escape.submit} />
            <HintPanel
              state={state}
              hintTags={ui.hintTags}
              canPlay={block === null}
              askHint={escape.askHint}
            />
          </>
        )}
      </>
    );
  }

  // A hosted event's brand and colours (M7 §1.9), over the room's theme.
  const look = escape.look;
  return (
    <LiveTheme theme={look.theme}>
      <div className="mx-auto flex min-h-0 w-full max-w-[24em] flex-1 flex-col gap-4 overflow-y-auto overscroll-y-contain px-4 pb-4 text-left">
        {look.brand ? <BrandBand brand={look.brand} className="pt-2" /> : null}
        {hostAway && !ui.finale && ui.ended === 'none' && (
          <p className="bg-muted text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
            <UserRoundX aria-hidden className="size-4 shrink-0" />
            {t('hostAway')}
          </p>
        )}
        {screen}
        {isPhoneHost && state && ui.ended !== 'final' ? (
          <PhoneHostBar pin={pin} state={state} room={phoneHost.room} send={phoneHost.send} />
        ) : null}
        <UnlockMoment overlay={ui.overlay} onClose={() => dispatch({ type: 'dismissOverlay' })} />
        <EscapeAnnouncer polite={ui.polite} assertive={ui.assertive} />
      </div>
    </LiveTheme>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="my-auto flex flex-col items-center gap-3 py-6 text-center">
      <Loader2 aria-hidden className="text-primary size-8 animate-spin" />
      <span className="text-lg font-semibold">{text}</span>
    </p>
  );
}

/**
 * The team got out: the last stage's unlock text, its time (frozen at the escape) and
 * the wait for the others. The heading takes the focus the unlock moment hands on.
 */
export function EscapedView({
  state,
  unlockText,
  timeMs,
}: {
  state: EscapePlayerState;
  /** The last stage's unlock text, when this phone saw the escape. */
  unlockText: string | null;
  /** The run's time at the escape (`team.escapedMs`). */
  timeMs: number;
}) {
  const { t } = useTranslation('escape');
  return (
    <section className="my-auto flex flex-col items-center gap-4 text-center">
      <PartyPopper aria-hidden className="text-primary size-12" />
      <h1 id={STAGE_TITLE_ID} tabIndex={-1} className="text-[1.5em] font-bold focus:outline-none">
        {t('end.escaped')}
      </h1>
      {unlockText && <p className="text-lg whitespace-pre-line">{unlockText}</p>}
      <p className="text-muted-foreground">
        {t('end.teamTime', { name: state.team?.name ?? '', time: formatClock(timeMs) })}
      </p>
      <p className="text-muted-foreground text-sm">{t('end.waitingOthers')}</p>
    </section>
  );
}

/** The team's time ran out: how far it got. */
export function TimeUpView({ state }: { state: EscapePlayerState }) {
  const { t } = useTranslation('escape');
  const team = state.team;
  return (
    <section className="my-auto flex flex-col items-center gap-4 text-center">
      <Hourglass aria-hidden className="text-muted-foreground size-12" />
      <h1 id={STAGE_TITLE_ID} tabIndex={-1} className="text-[1.5em] font-bold focus:outline-none">
        {t('end.timeUp')}
      </h1>
      {team && (
        <p className="text-muted-foreground">
          {t('end.stagesCleared', { done: team.stageIndex, total: team.stageCount })}
        </p>
      )}
      <p className="text-muted-foreground text-sm">{t('end.waitingOthers')}</p>
    </section>
  );
}
