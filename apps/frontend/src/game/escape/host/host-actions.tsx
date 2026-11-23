import type { EscapeHostOutline, EscapeHostTeam, EscapePhase } from '@quiz-dock/contracts';
import { Flag, KeyRound, Lightbulb, Pause, Play } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { GameSocket } from '../../game-client';
import { BackToLobbyButton } from '../../room-components';
import { formatDelta } from '../escape-reducer';
import { can, type ToolSet } from '../session/session-tools';
import { type EscapeHostUi, type HostLockView, nextHintOf } from './host-reducer';

/**
 * The host's run actions (M5 Task 5.13): hints, time, unlocks, pause and end. Each
 * says what it costs before it is sent (owner rules): a hint the host gives adds its
 * penalty to the team's score; extra time moves the deadline only, never the score.
 * Every command is busy until its answer (the hook drops a second send), and a
 * refusal shows its `errors` text inline.
 */

/** What the actions need of `useEscapeHost`. */
export interface HostCommands {
  pending: EscapeHostUi['pending'];
  /**
   * How many teams got a hint (0: none left); undefined when one was already on its
   * way. `hintId`: the hint the host confirmed for that team (refused if it changed).
   */
  hint: (teamId?: string, hintId?: string) => Promise<number | undefined>;
  adjustTime: (deltaS: number, teamId?: string) => Promise<unknown>;
  unlock: (teamId: string, lockId: string) => Promise<unknown>;
  pause: (paused: boolean) => Promise<unknown>;
  end: () => Promise<unknown>;
  /** What the session type allows (M7): a tool it lacks is not shown. Absent: every tool. */
  tools?: ToolSet;
}

/** The time steps, in minutes. */
export const TIME_STEPS = [-1, 1, 2, 5];
/** The custom value's bounds, in minutes (the server takes up to an hour either way). */
const CUSTOM_MAX = 60;

/** Runs a command and keeps its refusal text; `note` is what to say after it. */
function useRun() {
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(send: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await send();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  return { error, run };
}

function Alert({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-destructive text-sm">
      {text}
    </p>
  ) : null;
}

function Note({ text }: { text: string | null }) {
  return text ? (
    <p role="status" className="text-muted-foreground text-sm">
      {text}
    </p>
  ) : null;
}

/** A hint as the confirm shows it. */
type HintView = NonNullable<ReturnType<typeof nextHintOf>>;

/** A team still playing can get a hint or time; escaped or timed out, nothing moves. */
const playing = (team: Pick<EscapeHostTeam, 'escaped' | 'timedOut'>) =>
  !team.escaped && !team.timedOut;

/**
 * Give one team its next hint. The confirm shows the hint's text and what it adds
 * to the team's score; with no hint left, it says so and sends nothing.
 */
export function GiveHintButton({
  outline,
  team,
  commands,
  compact,
}: {
  outline: EscapeHostOutline;
  team: EscapeHostTeam;
  commands: Pick<HostCommands, 'hint' | 'pending' | 'tools'>;
  /** The stuck badge's quick button: smaller, still tap-sized. */
  compact?: boolean;
}) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  // The hint the confirm shows, kept from when it opened: a payload that moves the
  // team on meanwhile must not change what the host agreed to pay for.
  const [asking, setAsking] = useState<HintView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = !!commands.pending.hint;
  const onClick = () => {
    setNote(null);
    const next = nextHintOf(outline, team);
    if (!next) setNote(t('host.actions.hintNone'));
    else setAsking(next);
  };
  const confirm = async (hintId: string) => {
    setAsking(null);
    const released = await run(() => commands.hint(team.id, hintId));
    if (released === 0) setNote(t('host.actions.hintNone'));
  };
  if (!can(commands.tools, 'hint-team')) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant={compact ? 'outline' : 'default'}
        className={compact ? 'min-h-11' : 'min-h-12'}
        disabled={!playing(team) || busy}
        aria-busy={busy}
        aria-label={compact ? t('host.actions.hintTeamLabel', { team: team.name }) : undefined}
        onClick={onClick}
      >
        <Lightbulb className="size-4" aria-hidden />
        {t('host.actions.hint')}
      </Button>
      <Note text={note} />
      <Alert text={error} />
      <ConfirmDialog
        open={!!asking}
        title={t('host.actions.hintTeamTitle', { team: team.name })}
        description={t('host.actions.hintTeamCost', { seconds: asking?.penaltyS ?? 0 })}
        confirmLabel={t('host.actions.hintConfirm')}
        onConfirm={() => asking && void confirm(asking.id)}
        onCancel={() => setAsking(null)}
      >
        {asking ? (
          <blockquote className="border-l-4 pl-3 text-sm italic">{asking.text}</blockquote>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The next hint to every team still playing; the answer says how many got one. */
function HintAllButton({
  commands,
}: {
  commands: Pick<HostCommands, 'hint' | 'pending' | 'tools'>;
}) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busy = !!commands.pending.hint;
  const confirm = async () => {
    setAsking(false);
    setNote(null);
    const released = await run(() => commands.hint());
    if (released !== undefined) setNote(t('host.actions.hintAllDone', { count: released }));
  };
  if (!can(commands.tools, 'hint-all')) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-12"
        disabled={busy}
        aria-busy={busy}
        onClick={() => setAsking(true)}
      >
        <Lightbulb className="size-4" aria-hidden />
        {t('host.actions.hintAll')}
      </Button>
      <Note text={note} />
      <Alert text={error} />
      <ConfirmDialog
        open={asking}
        title={t('host.actions.hintAllTitle')}
        description={t('host.actions.hintAllCost')}
        confirmLabel={t('host.actions.hintConfirm')}
        onConfirm={() => void confirm()}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}

/**
 * Time for one team, or all: −1, +1, +2, +5 minutes, or a custom number. It moves
 * the deadline only (said beside the buttons, before any send); taking time away
 * asks first. Zero is never sent.
 */
export function TimeControls({
  team,
  commands,
  disabled,
}: {
  /** Absent: every team. */
  team?: Pick<EscapeHostTeam, 'id' | 'name'>;
  commands: Pick<HostCommands, 'adjustTime' | 'pending'>;
  disabled?: boolean;
}) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  const [custom, setCustom] = useState('');
  const [removing, setRemoving] = useState<number | null>(null);
  const busy = !!commands.pending.time;
  const target = team ? team.name : t('host.actions.allTeams');
  const send = (minutes: number) => {
    if (!minutes) return;
    if (minutes < 0) return setRemoving(minutes);
    void run(() => commands.adjustTime(minutes * 60, team?.id));
  };
  const customMinutes = Number(custom);
  const customOk =
    custom.trim() !== '' &&
    Number.isInteger(customMinutes) &&
    customMinutes !== 0 &&
    Math.abs(customMinutes) <= CUSTOM_MAX;
  const inputId = `escape-time-${team?.id ?? 'all'}`;
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium">
        {team ? t('host.actions.timeTeam', { team: team.name }) : t('host.actions.timeAll')}
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {TIME_STEPS.map((m) => (
          <Button
            key={m}
            type="button"
            variant="outline"
            className={cn('min-h-12 min-w-12 tabular-nums', m < 0 && 'text-destructive')}
            disabled={busy}
            aria-label={t('host.actions.timeFor', { delta: formatDelta(m * 60_000), target })}
            onClick={() => send(m)}
          >
            {formatDelta(m * 60_000)}
          </Button>
        ))}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!customOk) return;
            send(customMinutes);
            setCustom('');
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t('host.actions.customLabel', { target })}
          </label>
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            step={1}
            min={-CUSTOM_MAX}
            max={CUSTOM_MAX}
            placeholder={t('host.actions.customPlaceholder')}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="min-h-11 w-24 text-base"
          />
          <Button type="submit" variant="outline" className="min-h-11" disabled={busy || !customOk}>
            {t('host.actions.customApply')}
          </Button>
        </form>
      </div>
      <p className="text-muted-foreground text-xs">{t('host.actions.timeNote')}</p>
      <Alert text={error} />
      <ConfirmDialog
        open={removing !== null}
        title={t('host.actions.removeTitle', {
          delta: formatDelta((removing ?? 0) * 60_000),
          target,
        })}
        description={t('host.actions.timeNote')}
        confirmLabel={t('host.actions.removeConfirm')}
        destructive
        onConfirm={() => {
          const m = removing ?? 0;
          setRemoving(null);
          void run(() => commands.adjustTime(m * 60, team?.id));
        }}
        onCancel={() => setRemoving(null)}
      />
    </fieldset>
  );
}

/** Opens a closed lock for a team, after a confirm: it is marked in the results. */
export function UnlockButton({
  team,
  lock,
  commands,
}: {
  team: Pick<EscapeHostTeam, 'id' | 'name' | 'escaped' | 'timedOut'>;
  lock: Pick<HostLockView, 'id' | 'label'>;
  commands: Pick<HostCommands, 'unlock' | 'pending' | 'tools'>;
}) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  const [asking, setAsking] = useState(false);
  const busy = !!commands.pending.unlock;
  if (!can(commands.tools, 'unlock')) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={!playing(team) || busy}
        aria-busy={busy}
        aria-label={t('host.actions.unlockLabel', { lock: lock.label, team: team.name })}
        onClick={() => setAsking(true)}
      >
        <KeyRound className="size-4" aria-hidden />
        {t('host.actions.unlock')}
      </Button>
      <Alert text={error} />
      <ConfirmDialog
        open={asking}
        title={t('host.actions.unlockTitle', { lock: lock.label, team: team.name })}
        description={t('host.actions.unlockDescription')}
        confirmLabel={t('host.actions.unlockConfirm')}
        onConfirm={() => {
          setAsking(false);
          void run(() => commands.unlock(team.id, lock.id));
        }}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}

/** Where a key belongs to the element that has the focus (the quiz console's guard). */
const INTERACTIVE =
  'input, textarea, select, button, a, [role="tab"], [role="slider"], [role="switch"], [contenteditable="true"], dialog';
const onControl = (e: KeyboardEvent) =>
  e.target instanceof Element && !!e.target.closest(INTERACTIVE);
/** A modal is open (a confirm): the space bar is its own. */
const dialogOpen = () => !!document.querySelector('dialog[open], [role="dialog"]');

/** Pause and resume, one toggle; the space bar toggles it too, as in the quiz console. */
function PauseToggle({
  paused,
  commands,
}: {
  paused: boolean;
  commands: Pick<HostCommands, 'pause' | 'pending'>;
}) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  const busy = !!commands.pending.pause;
  const toggle = useRef<() => void>(() => {});
  toggle.current = () => void run(() => commands.pause(!paused));
  useHotkeys('space', () => toggle.current(), {
    preventDefault: true,
    ignoreEventWhen: (e) => e.repeat || onControl(e) || dialogOpen(),
  });
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant={paused ? 'main-action' : 'outline'}
        size="lg"
        className="min-h-12"
        disabled={busy}
        aria-busy={busy}
        aria-keyshortcuts="Space"
        onClick={() => toggle.current()}
      >
        {paused ? (
          <Play className="size-4" aria-hidden />
        ) : (
          <Pause className="size-4" aria-hidden />
        )}
        {paused ? t('host.actions.resume') : t('host.actions.pause')}
      </Button>
      <Alert text={error} />
    </div>
  );
}

/** Ends the run for every team, after a confirm; the results follow on `escape:finale`. */
function EndButton({ commands }: { commands: Pick<HostCommands, 'end' | 'pending'> }) {
  const { t } = useTranslation('escape');
  const { error, run } = useRun();
  const [asking, setAsking] = useState(false);
  const busy = !!commands.pending.end;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="destructive"
        className="min-h-12"
        disabled={busy}
        aria-busy={busy}
        onClick={() => setAsking(true)}
      >
        <Flag className="size-4" aria-hidden />
        {t('host.actions.end')}
      </Button>
      <Alert text={error} />
      <ConfirmDialog
        open={asking}
        title={t('host.actions.endTitle')}
        description={t('host.actions.endDescription')}
        confirmLabel={t('host.actions.endConfirm')}
        destructive
        onConfirm={() => {
          setAsking(false);
          void run(() => commands.end());
        }}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}

/**
 * The run-wide bar while the run is on: pause, a hint to all, time for all, end,
 * and stop (back to the lobby). Nothing of it once the finale is on: the results
 * have their own actions.
 */
export function RunBar({
  pin,
  socket,
  phase,
  paused,
  commands,
  extra,
}: {
  pin: string;
  socket: GameSocket | null;
  phase: EscapePhase;
  paused: boolean;
  commands: HostCommands;
  /** More controls for the bar (the console adds its own). */
  extra?: ReactNode;
}) {
  const { t } = useTranslation('escape');
  if (phase !== 'running') return null;
  return (
    <section
      aria-label={t('host.actions.bar')}
      className="flex flex-col gap-3 rounded-lg border p-3 md:p-4"
    >
      <div className="flex flex-wrap items-start gap-2">
        {can(commands.tools, 'pause') ? <PauseToggle paused={paused} commands={commands} /> : null}
        <HintAllButton commands={commands} />
        {can(commands.tools, 'end') ? <EndButton commands={commands} /> : null}
        <BackToLobbyButton pin={pin} socket={socket} mode="stop" offerArchive={false} />
        {extra}
      </div>
      {can(commands.tools, 'adjust-all') ? <TimeControls commands={commands} /> : null}
    </section>
  );
}

/** The per-team actions in the team detail: a hint and time for this team. */
export function TeamActions({
  outline,
  team,
  commands,
}: {
  outline: EscapeHostOutline;
  team: EscapeHostTeam;
  commands: HostCommands;
}) {
  const { t } = useTranslation('escape');
  const time = can(commands.tools, 'adjust-team');
  if (!time && !can(commands.tools, 'hint-team')) return null;
  return (
    <section
      aria-label={t('host.actions.team', { team: team.name })}
      className="flex flex-col gap-3"
    >
      <GiveHintButton outline={outline} team={team} commands={commands} />
      {time ? <TimeControls team={team} commands={commands} disabled={!playing(team)} /> : null}
    </section>
  );
}
