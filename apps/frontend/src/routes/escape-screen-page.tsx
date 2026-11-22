import type { EscapePhase } from '@quiz-dock/contracts';
import { Maximize, Minimize, Pause } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFullscreen } from '@/lib/use-fullscreen';
import { cn } from '@/lib/utils';
import { ScreenBanners } from '../game/escape/screen/banners';
import { RaceTrack } from '../game/escape/screen/race-track';
import { ScreenFinale } from '../game/escape/screen/screen-finale';
import { ScreenLobby } from '../game/escape/screen/screen-lobby';
import { screenPaletteOf } from '../game/escape/screen/screen-palette';
import { ScreenSoundUnlock, useEscapeScreenSounds } from '../game/escape/screen/screen-sounds';
import { ShowClock } from '../game/escape/screen/show-clock';
import type { EscapeScreenSession } from '../game/escape/screen/use-escape-screen';
import { useNow } from '../game/escape/use-now';
import { TYPE_BASE } from '../game/live-components';
import { unlockAudio } from '../game/media/audio-unlock';
import { LiveMotion } from '../game/motion/level';
import { roomLabel } from '../game/room-components';
import { LiveTheme } from '../game/theme';
import type { GameView } from '../game/use-game-session';
import type { ScreenRole } from './screen-page';

/** The pointer goes after this long without a move: nothing on a TV is to be clicked. */
const CURSOR_IDLE_MS = 3000;

/** True once the pointer has not moved over `el` for CURSOR_IDLE_MS. */
function useIdleCursor() {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = () => {
    setIdle(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), CURSOR_IDLE_MS);
  };
  useEffect(() => {
    timer.current = setTimeout(() => setIdle(true), CURSOR_IDLE_MS);
    return () => clearTimeout(timer.current);
  }, []);
  return { idle, wake };
}

/**
 * The escape big screen (M6 Task 6.14), composed by phase in upstream's screen frame
 * (room theme, motion level, one em type base): a top band (title, room, the PIN while
 * players can still join), the stage (the lobby, the race, or the screen finale) and a
 * bottom band (banners and the show clock) while the run is on. One server-time tick
 * (`useNow`, through `serverNow`) drives the clock, the lanes and the sounds together.
 * The host leaving changes nothing here; a lost connection keeps the last view (the
 * banner is upstream's, drawn by `ScreenView`).
 */
export function EscapeScreen({
  pin,
  view,
  escape,
  role,
  sound,
}: {
  pin: string;
  view: GameView;
  escape: EscapeScreenSession;
  role: ScreenRole;
  /** Whether a `follow` copy plays the sound. */
  sound: boolean;
}) {
  const { t } = useTranslation('escape');
  const { ui, replayDone } = escape;
  const { board, finale } = ui;
  const now = useNow(1000);
  // The projection plays the room's sound; a participant's copy only with ?sound=1, and
  // not when the room sends its sound to the projection only (as upstream's copy).
  const audible =
    role === 'lead' || (role === 'follow' && sound && view.gameAudioTarget !== 'projection');
  useEscapeScreenSounds(ui, view.sounds, audible, { now, theme: view.theme });
  const { ref, isFullscreen, toggle, supported } = useFullscreen<HTMLDivElement>();
  const cursor = useIdleCursor();

  const phase: EscapePhase | null = finale ? 'finale' : (board?.phase ?? null);
  const paused = phase === 'running' && !!board?.clock.paused;
  // Late joiners still can: the PIN stays in the corner until the finale.
  const showPin = phase === 'forming' || phase === 'running';
  const title = finale?.title ?? board?.title ?? null;
  // Read from the back of the room: 7:1 text, the theme's background only when it allows.
  const palette = screenPaletteOf(view.theme);

  let stage;
  if (finale) {
    stage = (
      <ScreenFinale
        finale={finale}
        replay={ui.replay}
        closed={ui.closed}
        onReplayDone={replayDone}
      />
    );
  } else if (!board) {
    stage = (
      <p className="flex h-full items-center justify-center text-[1.6em] font-semibold">
        {t('host.header.loading')}
      </p>
    );
  } else if (board.phase === 'forming') {
    stage = <ScreenLobby board={board} pin={pin} view={view} />;
  } else {
    // Running, or the finale before its screen finale came: the race as it stood.
    stage = <RaceTrack board={board} now={now} />;
  }

  return (
    <LiveTheme theme={view.theme}>
      <LiveMotion on={view.motion}>
        <div
          ref={ref}
          data-escape-phase={phase ?? 'none'}
          data-palette={palette.source}
          data-tone={palette.tone}
          style={palette.style}
          onMouseMove={cursor.wake}
          className={cn(
            'qd-screen bg-background text-foreground relative flex h-dvh flex-col overflow-hidden',
            // A 5% inset: TVs overscan.
            'gap-[0.8em] px-[5vw] py-[5vh]',
            TYPE_BASE.screen,
            cursor.idle && 'cursor-none',
          )}
        >
          {supported ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="bg-background absolute top-[1em] right-[1em] z-40"
              aria-label={
                isFullscreen ? t('live:screen.exitFullscreen') : t('live:screen.fullscreen')
              }
              onClick={() => {
                // The click that fills the screen also lets this window play sound.
                void unlockAudio();
                void toggle();
              }}
            >
              {isFullscreen ? (
                <Minimize aria-hidden className="size-[1.2em]" />
              ) : (
                <Maximize aria-hidden className="size-[1.2em]" />
              )}
            </Button>
          ) : null}
          {/* The room is gone after the finale: nothing more to hear. */}
          <ScreenSoundUnlock audible={audible && !ui.closed} />

          <header className="flex shrink-0 items-center justify-between gap-[1em] pr-[3em]">
            <div className="flex min-w-0 flex-col leading-tight">
              {/* The lobby and the finale carry the title as their heading. */}
              {phase === 'running' && title ? (
                <h1 className="truncate text-[1.4em] font-bold">{title}</h1>
              ) : null}
              <span className="text-muted-foreground truncate text-[0.9em] font-medium">
                {roomLabel(t, view.roomName, view.hostName)}
              </span>
            </div>
            {showPin ? (
              <span
                data-testid="screen-pin"
                className="bg-muted shrink-0 rounded-[0.4em] px-[0.6em] py-[0.2em] font-mono text-[1.2em] font-bold tabular-nums"
              >
                {t('screen.lobby.pin', { digits: pin })}
              </span>
            ) : null}
          </header>

          <main
            data-testid="screen-stage"
            data-paused={paused}
            className={cn('relative min-h-0 flex-1', paused && 'grayscale')}
          >
            {stage}
          </main>
          {paused ? (
            <div
              data-testid="paused-banner"
              className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
            >
              <span className="bg-background flex items-center gap-[0.4em] rounded-[0.4em] border px-[1em] py-[0.4em] text-[3em] font-bold shadow">
                <Pause aria-hidden className="size-[1em]" />
                {t('timer.paused')}
              </span>
            </div>
          ) : null}

          {phase === 'running' && board ? (
            <footer className="flex shrink-0 items-end justify-between gap-[1.5em]">
              <div className="min-w-0 flex-1">
                <ScreenBanners ui={ui} />
              </div>
              <ShowClock board={board} now={now} />
            </footer>
          ) : null}
        </div>
      </LiveMotion>
    </LiveTheme>
  );
}
