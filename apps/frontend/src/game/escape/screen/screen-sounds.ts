import type { RoomSoundsPayload, ThemeValues } from '@quiz-dock/contracts';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { serverNow } from '../../clock';
import { getMixer, loopTrack, setRoomLevel, TRACK_FADE_S } from '../../media/audio-mixer';
import { useAudioUnlocked } from '../../media/audio-unlock';
import {
  loadSound,
  playEffect,
  synthClick,
  synthDing,
  synthGong,
  synthTick,
  TAC_HZ,
  TIC_HZ,
} from '../../media/game-sounds';
import { SoundUnlockOverlay } from '../../media/sound-unlock-overlay';
import { withThemeSounds } from '../../media/use-room-media';
import {
  type EscapeScreenUi,
  finalMinutesOf,
  LAST_SECONDS_MS,
  showClockOf,
} from './screen-reducer';
import { startTensionBed, type TensionBed } from './tension-bed';

/**
 * The big screen's sounds (M6 §1.9), on upstream's mixer: an effect as each banner is
 * shown (so sound and picture match), the tic-tac over the run clock's last 10 s and the
 * gong on zero, and tension music in the final minutes (the room's track, else the
 * synthesised bed). Only where `audible` (the projection, or a copy with `?sound=1`),
 * after the page's one unlocking click, and never while the room is muted.
 */

/** The tic-tac is laid out this long before its first beat. */
const ARM_AHEAD_MS = 2000;
/** The bed's pulse quickens over the last minute. */
const URGENT_MS = 60_000;
/** A time-up banner this soon after the zero gong strikes no second one. */
const GONG_DEDUP_MS = 5000;
/** A gong this close to zero has started: a board saying "time up" does not call it off. */
const GONG_STRUCK_MS = 500;

export function useEscapeScreenSounds(
  ui: Pick<EscapeScreenUi, 'board' | 'current' | 'finale'>,
  sounds: RoomSoundsPayload | null,
  audible: boolean,
  { now, theme = null }: { now: number; theme?: ThemeValues | null },
): void {
  const unlocked = useAudioUnlocked();
  const room = useMemo(() => withThemeSounds(sounds, theme), [sounds, theme]);
  const on = audible && unlocked && !!room && !room.muted;
  const ctxRunning = useContextRunning(audible && unlocked);
  const running = () => getMixer()?.ctx.state === 'running';

  // The buses follow the room's levels; the host's mute silences both.
  useEffect(() => {
    if (!audible || !room) return;
    setRoomLevel('music', room.muted || room.musicMuted ? 0 : room.musicLevel);
    setRoomLevel('sfx', room.muted || room.sfxMuted ? 0 : room.sfxLevel);
  }, [audible, room]);

  // When the zero gong sounds (server ms), so a time-up banner does not strike another.
  const gongAt = useRef<number | null>(null);

  // One effect per banner shown, never late: a banner up before the unlock stays silent.
  const lastBanner = useRef<number | null>(null);
  const current = ui.current;
  useEffect(() => {
    if (!current || current.id === lastBanner.current) return;
    lastBanner.current = current.id;
    if (!on || !room || !running()) return;
    if (current.kind === 'stage-cleared' && room.ding) playEffect(room.dingUrl, synthDing);
    else if (current.kind === 'escaped' && room.gong) playEffect(room.gongUrl, synthGong);
    else if (current.kind === 'hint' && room.tick) playEffect(room.tickUrl, synthTick);
    else if (current.kind === 'time-up' && room.gong) {
      const struck =
        gongAt.current !== null && Math.abs(serverNow() - gongAt.current) < GONG_DEDUP_MS;
      if (!struck) playEffect(room.gongUrl, synthGong);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per banner id
  }, [current?.id]);

  const show = ui.board ? showClockOf(ui.board, now) : null;
  const deadlineAt = show && !show.paused ? show.deadlineAt : null;
  const armed = deadlineAt !== null && show!.remainingMs <= LAST_SECONDS_MS + ARM_AHEAD_MS;

  // The tic-tac on the server's clock, as upstream's countdown: tic on the second, tac on
  // the half, the last tac left out, then the gong on zero. A pause, extra time or the last
  // team out calls off what has not sounded.
  const countdown = !!room?.countdown;
  const gongOn = !!room?.gong;
  const countdownUrl = room?.countdownUrl ?? null;
  const gongUrl = room?.gongUrl ?? null;
  useEffect(() => {
    if (!on || !ctxRunning || !armed || deadlineAt === null) return;
    const ctx = getMixer()?.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const toCtx = (serverMs: number) => ctx.currentTime + (serverMs - serverNow()) / 1000;
    const clicks: (() => void)[] = [];
    let gong: (() => void) | null = null;
    if (countdown) {
      const first = deadlineAt - LAST_SECONDS_MS;
      for (let slot = 0; slot < (LAST_SECONDS_MS / 1000) * 2 - 1; slot++) {
        const at = first + slot * 500;
        if (at < serverNow() - 50) continue;
        const tic = slot % 2 === 0;
        clicks.push(
          playEffect(
            countdownUrl,
            (when) => synthClick(when ?? toCtx(at), tic ? TIC_HZ : TAC_HZ),
            toCtx(at),
            tic ? 1 : TAC_HZ / TIC_HZ,
          ),
        );
      }
    }
    // Zero gone by (unmuted late), or this zero's gong already sounding: none again.
    if (gongOn && deadlineAt > serverNow() && gongAt.current !== deadlineAt) {
      gong = playEffect(gongUrl, synthGong, toCtx(deadlineAt));
      gongAt.current = deadlineAt;
    }
    return () => {
      clicks.forEach((cancel) => cancel());
      if (gong && serverNow() < deadlineAt - GONG_STRUCK_MS) {
        gong();
        gongAt.current = null;
      }
    };
  }, [on, ctxRunning, armed, deadlineAt, countdown, gongOn, countdownUrl, gongUrl]);

  // Tension music: from the final minutes until a pause, the finale or the mute.
  const board = ui.board;
  const musicOn =
    on &&
    !!board &&
    board.phase === 'running' &&
    !ui.finale &&
    !board.clock.paused &&
    finalMinutesOf(board, now);
  const urgent = !!show && show.remainingMs <= URGENT_MS;
  // Kept through a mute (which holds it), so unmuting picks it up where it was.
  const trackUrl = audible && unlocked ? (room?.musicUrl ?? null) : null;

  const [track, setTrack] = useState<ReturnType<typeof loopTrack> | null>(null);
  useEffect(() => {
    if (!trackUrl) return;
    let cancelled = false;
    let loaded: ReturnType<typeof loopTrack> | null = null;
    void loadSound(trackUrl).then((buffer) => {
      if (cancelled || !buffer) return;
      loaded = loopTrack(buffer, 'music', { fadeInS: TRACK_FADE_S, fadeOutS: TRACK_FADE_S });
      setTrack(loaded);
    });
    return () => {
      cancelled = true;
      loaded?.hold();
      setTrack(null);
    };
  }, [trackUrl]);
  useEffect(() => {
    if (!track) return;
    if (musicOn && ctxRunning) track.play();
    else track.hold();
  }, [track, musicOn, ctxRunning]);

  const bed = useRef<TensionBed | null>(null);
  const bedOn = musicOn && !trackUrl;
  useEffect(() => {
    if (!bedOn || !ctxRunning) return;
    const started = startTensionBed({ fadeInS: TRACK_FADE_S });
    bed.current = started;
    return () => {
      started.stop(TRACK_FADE_S);
      bed.current = null;
    };
  }, [bedOn, ctxRunning]);
  useEffect(() => {
    bed.current?.setUrgent(urgent);
  }, [bedOn, ctxRunning, urgent]);
}

/**
 * Whether the page's audio context runs, kept up to date: a context can still be
 * suspended after the unlock (the browser resumes it later), and what waits for it
 * (tic-tac, music) starts once it runs.
 */
function useContextRunning(active: boolean): boolean {
  const [isRunning, setRunning] = useState(() => active && getMixer()?.ctx.state === 'running');
  useEffect(() => {
    if (!active) {
      setRunning(false);
      return;
    }
    const ctx = getMixer()?.ctx;
    if (!ctx) return;
    const update = () => setRunning(ctx.state === 'running');
    update();
    ctx.addEventListener('statechange', update);
    return () => ctx.removeEventListener('statechange', update);
  }, [active]);
  return isRunning;
}

/**
 * The "Enable sound" overlay (upstream's), on a screen that plays sound, until the click.
 * A follow copy without `?sound=1` is not audible and never asks.
 */
export function ScreenSoundUnlock({ audible }: { audible: boolean }) {
  const unlocked = useAudioUnlocked();
  return audible && !unlocked ? createElement(SoundUnlockOverlay) : null;
}
