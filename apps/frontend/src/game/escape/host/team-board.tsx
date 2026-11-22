import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type KeyboardCoordinateGetter,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { EscapeHostOutline, EscapeHostState } from '@quiz-dock/contracts';
import { ArrowRightLeft, GripVertical, Play, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Popover } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Avatar } from '../../avatar';
import { coverageOf, readinessOf } from './host-reducer';

/** The touch hold before a drag starts: a quick swipe still scrolls the page. */
export const TOUCH_DELAY_MS = 150;
/** The droppable id of the players without a team. */
const UNASSIGNED = 'unassigned';

interface Chip {
  playerId: string;
  nickname: string;
  connected: boolean;
  /** Role names (roles mode), from the lobby's preview deal. */
  roles: string[];
  /** Where it is now: a team id, or UNASSIGNED. */
  column: string;
}

interface Column {
  id: string;
  name: string;
  chips: Chip[];
}

const NEXT = ['ArrowRight', 'ArrowDown'];
const PREV = ['ArrowLeft', 'ArrowUp'];

/**
 * The keyboard drag goes column to column: an arrow puts the player over the
 * next (or previous) team, in the order the board shows them.
 */
export const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { active } = context;
  const step = NEXT.includes(event.code) ? 1 : PREV.includes(event.code) ? -1 : 0;
  if (!step) return undefined;
  event.preventDefault();
  const ids = context.droppableContainers.getEnabled().map((c) => c.id);
  if (ids.length === 0) return undefined;
  const from = context.over?.id ?? active?.data.current?.column;
  const at = Math.max(0, ids.indexOf(from));
  const to = ids[Math.min(ids.length - 1, Math.max(0, at + step))];
  const rect = context.droppableRects.get(to);
  if (!rect) return undefined;
  const size = context.collisionRect;
  return {
    x: rect.left + rect.width / 2 - (size?.width ?? 0) / 2,
    y: rect.top + rect.height / 2 - (size?.height ?? 0) / 2,
  };
};

/** Under the pointer when there is one (mouse, touch); else the nearest column (keyboard). */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

/**
 * The lobby's team board (M5 Task 5.10): each team and the unassigned players,
 * moved by drag and drop (pointer, touch, keyboard) or by each chip's "Move to…"
 * menu; each team's role coverage and connections; Start, which warns but never
 * blocks (owner question 3). While the run is on, a move is a late fix, confirmed
 * first: the player's roles are dealt again.
 */
export function TeamBoard({
  outline,
  host,
  onMove,
  onStart,
  moving,
  starting,
}: {
  outline: EscapeHostOutline;
  host: EscapeHostState;
  onMove: (playerId: string, teamId: string | null) => Promise<unknown>;
  onStart: () => Promise<unknown>;
  moving: boolean;
  starting: boolean;
}) {
  const { t } = useTranslation('escape');
  const [error, setError] = useState<string | null>(null);
  const [lateMove, setLateMove] = useState<{ chip: Chip; to: Column } | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_DELAY_MS, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }),
  );

  const phase = host.board.phase;
  if (phase !== 'forming' && phase !== 'running') return null;
  const running = phase === 'running';
  const roleName = new Map(outline.roles.map((r) => [r.id, r.name]));
  const roles = outline.mode === 'roles';

  const columns: Column[] = [
    ...host.teams.map((team) => ({
      id: team.id,
      name: team.name,
      chips: team.members.map((m) => ({
        playerId: m.playerId,
        nickname: m.nickname,
        connected: m.connected,
        roles: roles ? m.roles.map((r) => roleName.get(r) ?? r) : [],
        column: team.id,
      })),
    })),
    {
      id: UNASSIGNED,
      name: t('host.board.unassigned'),
      chips: host.unassigned.map((p) => ({ ...p, roles: [], column: UNASSIGNED })),
    },
  ];
  const chipOf = (playerId: string) =>
    columns.flatMap((c) => c.chips).find((c) => c.playerId === playerId);
  const columnOf = (id: string) => columns.find((c) => c.id === id);

  const send = async (playerId: string, to: string) => {
    setError(null);
    try {
      await onMove(playerId, to === UNASSIGNED ? null : to);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** Each way of moving lands here; a late move (running) is confirmed first. */
  const requestMove = (playerId: string, to: string) => {
    const chip = chipOf(playerId);
    const column = columnOf(to);
    if (!chip || !column || chip.column === to || moving) return;
    if (running) setLateMove({ chip, to: column });
    else void send(playerId, to);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) requestMove(String(active.id), String(over.id));
  };

  const nameOf = (id: string | number) => chipOf(String(id))?.nickname ?? '';
  const teamName = (id: string | number | undefined) =>
    id === undefined ? '' : (columnOf(String(id))?.name ?? '');
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('host.board.dnd.start', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('host.board.dnd.over', { name: nameOf(active.id), team: teamName(over.id) })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? t('host.board.dnd.end', { name: nameOf(active.id), team: teamName(over.id) })
        : t('host.board.dnd.endNowhere', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('host.board.dnd.cancel', { name: nameOf(active.id) }),
  };

  // Start (forming): warns about what may be off, never blocks.
  const canStart = host.teams.some((team) => team.members.length > 0);
  const emptyTeams = host.teams.filter((team) => team.members.length === 0).map((x) => x.name);
  const offline = host.teams.flatMap((team) =>
    team.members.filter((m) => !m.connected).map((m) => m.nickname),
  );
  const warnings = [
    emptyTeams.length ? t('host.board.warnEmpty', { teams: emptyTeams.join(', ') }) : null,
    offline.length ? t('host.board.warnOffline', { names: offline.join(', ') }) : null,
    host.unassigned.length
      ? t('host.board.warnUnassigned', { players: host.unassigned.length })
      : null,
  ].filter((w): w is string => w !== null);
  const start = async () => {
    setConfirmStart(false);
    setError(null);
    try {
      await onStart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-labelledby="escape-board" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="escape-board" className="text-lg font-semibold">
          {t('host.board.title')}
        </h2>
        {!running ? (
          <Button
            type="button"
            variant="main-action"
            size="lg"
            className="min-h-12"
            disabled={!canStart}
            aria-busy={starting}
            onClick={() => (warnings.length ? setConfirmStart(true) : void start())}
          >
            <Play className="size-4" aria-hidden />
            {t('host.board.start')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('host.board.dnd.instructions') },
        }}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {columns.map((column, i) => (
            <BoardColumn
              key={column.id}
              index={i}
              column={column}
              columns={columns}
              coverage={column.id === UNASSIGNED ? null : coverageLine(outline, host, column.id, t)}
              onMove={requestMove}
            />
          ))}
        </div>
      </DndContext>

      <ConfirmDialog
        open={confirmStart}
        title={t('host.board.startTitle')}
        description={t('host.board.startDescription')}
        confirmLabel={t('host.board.startConfirm')}
        onConfirm={() => void start()}
        onCancel={() => setConfirmStart(false)}
      >
        <ul className="list-disc pl-5 text-sm">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={lateMove !== null}
        title={t('host.board.moveTitle', {
          name: lateMove?.chip.nickname ?? '',
          team: lateMove?.to.name ?? '',
        })}
        description={t(roles ? 'host.board.moveRoles' : 'host.board.moveParallel', {
          name: lateMove?.chip.nickname ?? '',
        })}
        confirmLabel={t('host.board.moveConfirm')}
        onConfirm={() => {
          const m = lateMove;
          setLateMove(null);
          if (m) void send(m.chip.playerId, m.to.id);
        }}
        onCancel={() => setLateMove(null)}
      />
    </section>
  );
}

type T = ReturnType<typeof useTranslation<'escape'>>['t'];

/** One team's line: role coverage (roles mode) and connections. */
function coverageLine(
  outline: EscapeHostOutline,
  host: EscapeHostState,
  teamId: string,
  t: T,
): { ready: string; roles: { text: string; warn: boolean } | null } | null {
  const team = host.teams.find((x) => x.id === teamId);
  if (!team) return null;
  const { connected, total } = readinessOf(team);
  const c = coverageOf(outline, team);
  const names = (ids: string[]) =>
    ids.map((id) => outline.roles.find((r) => r.id === id)?.name ?? id).join(', ');
  let roles: { text: string; warn: boolean } | null = null;
  if (c) {
    if (c.empty) roles = { text: t('host.board.coverage.empty'), warn: true };
    else if (c.shared) {
      roles = {
        text: t('host.board.coverage.shared', { roles: c.roles.length, players: total }),
        warn: false,
      };
    } else if (c.unheld.length) {
      roles = { text: t('host.board.coverage.unheld', { roles: names(c.unheld) }), warn: true };
    } else {
      roles = {
        text: t('host.board.coverage.allHeld', { roles: c.roles.map((r) => r.name).join(', ') }),
        warn: false,
      };
    }
  }
  return { ready: t('host.board.ready', { connected, total }), roles };
}

function BoardColumn({
  index,
  column,
  columns,
  coverage,
  onMove,
}: {
  index: number;
  column: Column;
  columns: Column[];
  coverage: ReturnType<typeof coverageLine>;
  onMove: (playerId: string, to: string) => void;
}) {
  const { t } = useTranslation('escape');
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const headingId = `escape-board-${column.id}`;
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      data-board-column={index}
      className={cn(
        'bg-card flex min-h-32 flex-col gap-2 rounded-lg border p-3',
        column.id === UNASSIGNED && 'border-dashed',
        isOver && 'ring-ring ring-2',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={headingId} className="font-semibold break-words">
          {column.name}
        </h3>
        {coverage ? (
          <>
            <p className="text-muted-foreground text-sm">{coverage.ready}</p>
            {coverage.roles ? (
              <p
                className={cn(
                  'text-sm',
                  coverage.roles.warn ? 'text-warning-text font-medium' : 'text-muted-foreground',
                )}
              >
                {coverage.roles.text}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {column.chips.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('host.board.nobody')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {column.chips.map((chip) => (
            <PlayerChip key={chip.playerId} chip={chip} columns={columns} onMove={onMove} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PlayerChip({
  chip,
  columns,
  onMove,
}: {
  chip: Chip;
  columns: Column[];
  onMove: (playerId: string, to: string) => void;
}) {
  const { t } = useTranslation('escape');
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({ id: chip.playerId, data: { column: chip.column } });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'bg-background flex items-center gap-1 rounded-md border',
        isDragging && 'relative z-10 shadow-lg',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('host.board.drag', { name: chip.nickname })}
        className="flex min-h-11 min-w-0 flex-1 touch-none items-center gap-2 px-2 py-1 text-left"
      >
        <GripVertical className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <Avatar name={chip.nickname} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{chip.nickname}</span>
          {chip.roles.length ? (
            <span className="text-muted-foreground truncate text-xs">{chip.roles.join(', ')}</span>
          ) : null}
        </span>
        {!chip.connected ? (
          <span className="text-warning-text ml-auto flex shrink-0 items-center gap-1 text-xs">
            <WifiOff className="size-3.5" aria-hidden />
            {t('host.board.offline')}
          </span>
        ) : null}
      </button>
      <Popover
        align="end"
        trigger={({ open, toggle }) => (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 min-w-11 shrink-0 px-2"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('host.board.moveTo', { name: chip.nickname })}
            onClick={toggle}
          >
            <ArrowRightLeft className="size-4" aria-hidden />
          </Button>
        )}
      >
        {(close) => (
          <div role="menu" className="flex flex-col p-1">
            {columns
              .filter((c) => c.id !== chip.column)
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  className="hover:bg-accent flex min-h-11 items-center rounded-md px-3 text-left text-sm"
                  onClick={() => {
                    close();
                    onMove(chip.playerId, c.id);
                  }}
                >
                  {c.name}
                </button>
              ))}
          </div>
        )}
      </Popover>
    </li>
  );
}
