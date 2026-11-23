import { useParams } from '@tanstack/react-router';
import { Flag, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWakeLock } from '@/lib/use-wake-lock';
import { useEscapeScreen } from '../game/escape/screen/use-escape-screen';
import { ConnectionLost } from '../game/live-components';
import { useGameSession } from '../game/use-game-session';
import { useAudienceLanguage } from '../i18n/interface-language';
import { EscapeScreen } from './escape-screen-page';

/** A full-screen line: the board's states that are not a race. */
function Notice({ children, busy = false }: { children: string; busy?: boolean }) {
  return (
    <div
      data-testid="race-board-notice"
      className="bg-background text-foreground flex h-dvh items-center justify-center overflow-hidden p-[5vw] text-center"
    >
      <p className="flex flex-col items-center gap-4 text-2xl font-semibold">
        {busy ? (
          <Loader2 aria-hidden className="text-primary size-10 motion-safe:animate-spin" />
        ) : (
          <Flag aria-hidden className="text-muted-foreground size-10" />
        )}
        {children}
      </p>
    </div>
  );
}

/**
 * The public race board (M7 Task 7.18), `/race/<PIN>`: no account. It follows the
 * room as a copy of its screen (`spectator:join { follow: true }`), so it never pairs,
 * takes no seat and is silent unless `?sound=1`. It draws the escape big screen: the
 * lobby with the PIN, the QR and the countdown, the leaders' race track with the show
 * clock and banners, then the screen finale. A room that is not a race shows no board.
 */
export function EscapeRaceBoardPage() {
  const { t } = useTranslation('escape');
  const { pin } = useParams({ from: '/race/$pin' });
  const sound = new URLSearchParams(window.location.search).get('sound') === '1';
  const session = useGameSession(pin, 'spectator', { follow: true });
  const escape = useEscapeScreen(pin, {
    view: session.view,
    attachSeq: session.attachSeq,
    socket: session.socket,
  });
  useAudienceLanguage(session.view.language);
  useWakeLock(session.view.status === 'ready' && session.view.state !== 'ENDED');

  const { board, finale } = escape.ui;
  let body;
  if (board && board.session?.type !== 'race' && !finale) {
    body = <Notice>{t('race.board.notARace')}</Notice>;
  } else if (!escape.active) {
    body =
      session.view.status === 'error' ? (
        <Notice>{session.view.error ?? t('race.board.notFound')}</Notice>
      ) : (
        <Notice busy>{t('host.header.loading')}</Notice>
      );
  } else {
    body = (
      <EscapeScreen pin={pin} view={session.view} escape={escape} role="follow" sound={sound} />
    );
  }
  return (
    <>
      <ConnectionLost lost={session.view.connectionLost} />
      {body}
    </>
  );
}
