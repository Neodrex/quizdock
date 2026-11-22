import type { EscapeBoard, EscapeHostOutline, EscapePhase } from '@quiz-dock/contracts';
import { Link } from '@tanstack/react-router';
import { DoorOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { PageTitle } from '@/components/ui/page-title';
import { cn } from '@/lib/utils';
import { ActivityFeed, ConsoleAnnouncer } from '../game/escape/host/activity-feed';
import { FormationPanel } from '../game/escape/host/formation-panel';
import { type HostCommands, RunBar } from '../game/escape/host/host-actions';
import { runMsAt } from '../game/escape/host/host-reducer';
import { HostResults, type ResultsCommands } from '../game/escape/host/host-results';
import { InvitePanel } from '../game/escape/host/invite-panel';
import { RunGrid, useTeamSelection } from '../game/escape/host/run-grid';
import { ScreenPanel } from '../game/escape/host/screen-panel';
import { TeamBoard } from '../game/escape/host/team-board';
import { TeamDetailPanel } from '../game/escape/host/team-detail';
import type { EscapeHost } from '../game/escape/host/use-escape-host';
import { useNow } from '../game/escape/use-now';
import { formatClock } from '../game/escape/team-timer';
import type { useGameSession } from '../game/use-game-session';

/**
 * The escape host console (M5 Task 5.16), composed by phase: the lobby (invite,
 * formation, team board and Start), the run (grid, team detail, activity feed and
 * the action bar) and the results. It renders only what the host is sent (the host
 * outline has no answers). While the connection is down every action is disabled
 * (it would be refused) and the view stays as it was; the quiz's HOST_DISCONNECTED
 * is the players' screen, never the host's own.
 */

/** As the quiz console: the page fills the window under the header, the bar at the bottom. */
const SECTION = 'flex min-h-[calc(100dvh-7rem)] flex-col gap-4 pb-6';

/** The run clock: elapsed of the limit, ticking once a second for the whole console. */
function RunClock({ board }: { board: EscapeBoard }) {
  const { t } = useTranslation('escape');
  const now = useNow(1000);
  const elapsed = formatClock(runMsAt(board.clock, now));
  const limit = formatClock(board.clock.limitMs);
  return (
    <span
      role="timer"
      aria-label={t('host.header.clockLabel')}
      className="font-mono text-sm tabular-nums"
    >
      {t('host.header.clock', { elapsed, limit })}
    </span>
  );
}

function Header({
  pin,
  outline,
  board,
  phase,
  session,
}: {
  pin: string;
  outline: EscapeHostOutline | null;
  board: EscapeBoard | null;
  phase: EscapePhase | null;
  session: ReturnType<typeof useGameSession>;
}) {
  const { t } = useTranslation('escape');
  const title = outline?.title ?? board?.title ?? t('host.console');
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <PageTitle className="min-w-0 break-words">{title}</PageTitle>
        <Badge variant="muted" className="font-mono tabular-nums">
          {t('host.header.pin', { pin })}
        </Badge>
        {phase ? <Badge variant="default">{t(`host.header.phase.${phase}`)}</Badge> : null}
        {board && phase === 'running' && board.clock.paused ? (
          <Badge variant="warning">{t('host.header.paused')}</Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {board && phase !== 'forming' ? <RunClock board={board} /> : null}
        {/* The big screen, in every phase: opened, paired and heard from here (M6). */}
        <ScreenPanel
          pin={pin}
          socket={session.socket}
          sounds={session.view.sounds}
          theme={session.view.theme}
          disabled={session.view.connectionLost}
        />
        <Link to="/escape" className={cn(buttonVariants({ variant: 'ghost' }), 'min-h-11')}>
          <DoorOpen className="size-4" aria-hidden />
          {t('host.nav')}
        </Link>
      </div>
    </header>
  );
}

export function EscapeConsole({
  pin,
  session,
  escape,
}: {
  pin: string;
  session: ReturnType<typeof useGameSession>;
  escape: EscapeHost;
}) {
  const { t } = useTranslation('escape');
  const { ui } = escape;
  const { outline, host, board, finale } = ui;
  const [selected, select] = useTeamSelection();
  const lost = session.view.connectionLost;
  const socket = session.socket;
  const closed = ui.ended === 'final';
  const phase: EscapePhase | null = closed ? 'finale' : (board?.phase ?? null);

  const commands: HostCommands = {
    pending: ui.pending,
    hint: escape.hint,
    adjustTime: escape.adjustTime,
    unlock: escape.unlock,
    pause: escape.pause,
    end: escape.end,
  };
  const results: ResultsCommands = {
    pending: ui.pending,
    finale: escape.finale,
    runAgain: escape.runAgain,
  };
  const team = host?.teams.find((x) => x.id === selected) ?? null;

  let body: ReactNode;
  const showResults = phase === 'finale' && !!finale;
  if (showResults) {
    const stageCount =
      outline?.stages.length ?? Math.max(0, ...finale.ranking.map((r) => r.stageClearedAt.length));
    body = (
      <HostResults
        finale={finale}
        closed={closed}
        pin={pin}
        socket={socket}
        stageCount={stageCount}
        commands={results}
        lost={lost}
      />
    );
  } else if (!outline || !host || !phase || phase === 'finale') {
    body = (
      <p role="status" className="text-muted-foreground">
        {t('host.header.loading')}
      </p>
    );
  } else if (phase === 'forming') {
    body = (
      <>
        <div className="grid gap-4 md:grid-cols-2">
          <InvitePanel
            pin={pin}
            view={session.view}
            onJoinUrl={(baseUrl) => socket?.emit('host:join-url', { pin, baseUrl })}
          />
          <FormationPanel
            outline={outline}
            host={host}
            onTeams={escape.teams}
            busy={!!ui.pending.teams}
          />
        </div>
        <TeamBoard
          outline={outline}
          host={host}
          onMove={escape.move}
          onStart={escape.start}
          moving={!!ui.pending.move}
          starting={!!ui.pending.start}
        />
      </>
    );
  } else {
    body = (
      <>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <RunGrid
              outline={outline}
              host={host}
              selected={selected}
              onSelect={select}
              commands={commands}
              heardAt={ui.heardAt}
            />
            <ActivityFeed
              gameId={host.gameId}
              feed={ui.feed}
              clock={board?.clock}
              teams={host.teams}
              selectedTeam={selected}
            />
          </div>
          <TeamDetailPanel
            outline={outline}
            team={team}
            hintSources={team ? ui.hintSources[team.id] : undefined}
            commands={commands}
            onClose={() => select(null)}
            disabled={lost}
          />
        </div>
        <div className="bg-background sticky bottom-0 z-10 mt-auto pt-2">
          <RunBar
            pin={pin}
            socket={socket}
            phase={phase}
            paused={!!board?.clock.paused}
            commands={commands}
          />
        </div>
      </>
    );
  }

  return (
    <section className={SECTION} data-escape-phase={phase ?? 'none'}>
      <Header pin={pin} outline={outline} board={board} phase={phase} session={session} />
      {/* Down, every action would be refused: all are off, and the view stays. The
          results disable their own commands, so the CSV (made locally) still downloads. */}
      <fieldset disabled={lost && !showResults} className="contents">
        {body}
      </fieldset>
      <ConsoleAnnouncer polite={ui.polite} />
    </section>
  );
}
