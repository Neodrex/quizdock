import type { EscapeHostOutline, EscapeHostTeam } from '@quiz-dock/contracts';
import {
  ArrowDownUp,
  Check,
  Hash,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Type,
  Users,
  WifiOff,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { Drawer } from '@/components/ui/drawer';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { mediaSrc } from '../clue-list';
import { formatDelta } from '../escape-reducer';
import { type HostCommands, TeamActions, UnlockButton } from './host-actions';
import { type HintSource, type HostLockView, nextHintOf, stageOf } from './host-reducer';
import { LAPTOP } from './run-grid';

/**
 * One team as the host sees it (M5 Task 5.12): its stage and locks (never what
 * opens them), the parts of its combined locks, its players, wrong tries, hints
 * (released and the next one, with their cost) and the stage's clues, so the host
 * can help without the answers. Its actions: a hint, time, and opening a lock.
 */

const KIND_ICON: Record<HostLockView['kind'], LucideIcon> = {
  code: Hash,
  phrase: Type,
  choice: ListChecks,
  sequence: ArrowDownUp,
  combined: Users,
};

function LockRow({
  lock,
  team,
  roleName,
  commands,
}: {
  lock: HostLockView;
  team: EscapeHostTeam;
  roleName: (id: string) => string;
  commands: Pick<HostCommands, 'unlock' | 'pending'>;
}) {
  const { t } = useTranslation('escape');
  const Icon = KIND_ICON[lock.kind];
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-lock={lock.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="sr-only">{t(`host.detail.kind.${lock.kind}`)}:</span>
        <span className="min-w-0 flex-1 font-medium break-words">{lock.label}</span>
        {lock.solved ? (
          <Badge variant={lock.byHost ? 'muted' : 'success'}>
            {lock.byHost ? (
              <KeyRound className="mr-1 size-3" aria-hidden />
            ) : (
              <Check className="mr-1 size-3" aria-hidden />
            )}
            {lock.byHost ? t('host.detail.openByHost') : t('host.detail.open')}
          </Badge>
        ) : (
          <Badge variant="default">{t('host.detail.closed')}</Badge>
        )}
      </div>
      {lock.kind === 'combined' && lock.partRoles?.length ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {lock.partRoles.map((r) => {
            const done = lock.solved || lock.partsDone.includes(r);
            return (
              <li
                key={r}
                className={cn(
                  'rounded-full border px-2 py-0.5',
                  done ? 'text-success-text border-success/40' : 'text-muted-foreground',
                )}
              >
                {t(done ? 'host.detail.partIn' : 'host.detail.partWaiting', { role: roleName(r) })}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!lock.solved ? (
        <div className="self-start">
          <UnlockButton team={team} lock={lock} commands={commands} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * A clue's body: text, or a media link only when its address is one this app may
 * open (`mediaSrc`, as on the phones); anything else stays plain text.
 */
function ClueBody({ kind, body }: { kind: string; body: string }) {
  const src = kind === 'text' ? null : mediaSrc(body);
  if (!src) return <p className="break-words whitespace-pre-line">{body}</p>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="break-all underline">
      {body}
    </a>
  );
}

/**
 * Where a released hint came from, and what it cost. Free or paid comes with the
 * team (`paidHintIds`, so it holds after a reload); asked or given is only known
 * from the update heard (`hintSources`).
 */
function sourceText(
  t: (k: string, o?: Record<string, unknown>) => string,
  paid: boolean,
  source: HintSource | undefined,
  seconds: number,
): string {
  if (!paid) return t('host.detail.source.timer');
  if (source === 'request') return t('host.detail.source.request', { seconds });
  if (source === 'host') return t('host.detail.source.host', { seconds });
  return t('host.detail.source.paid', { seconds });
}

export function TeamDetail({
  outline,
  team,
  hintSources,
  commands,
}: {
  outline: EscapeHostOutline;
  team: EscapeHostTeam;
  /** How each hint of this team was released, as heard (`EscapeHostUi.hintSources[id]`). */
  hintSources?: Record<string, HintSource>;
  commands: HostCommands;
}) {
  const { t } = useTranslation('escape');
  const roleName = (id: string) => outline.roles.find((r) => r.id === id)?.name ?? id;
  const current = stageOf(outline, team);
  const next = nextHintOf(outline, team);
  const allHints = outline.stages.flatMap((s) => s.hints);
  const released = team.hintIds
    .map((id) => allHints.find((h) => h.id === id))
    .filter((h): h is NonNullable<typeof h> => !!h);
  const roles = outline.mode === 'roles';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold break-words">{team.name}</h2>
        <p className="text-sm">
          {current
            ? t('host.detail.stage', {
                n: team.stageIndex + 1,
                count: team.stageCount,
                title: current.stage.title,
              })
            : t('host.detail.escaped')}
        </p>
        {team.adjustMs !== 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('host.detail.extraTime', { delta: formatDelta(team.adjustMs) })}
          </p>
        ) : null}
      </div>

      {current ? (
        <section aria-labelledby={`locks-${team.id}`} className="flex flex-col gap-2">
          <h3 id={`locks-${team.id}`} className="font-medium">
            {t('host.detail.locks')}
          </h3>
          <ul className="flex flex-col gap-2">
            {current.locks.map((l) => (
              <LockRow key={l.id} lock={l} team={team} roleName={roleName} commands={commands} />
            ))}
          </ul>
        </section>
      ) : null}

      <TeamActions outline={outline} team={team} commands={commands} />

      <section aria-labelledby={`hints-${team.id}`} className="flex flex-col gap-2">
        <h3 id={`hints-${team.id}`} className="font-medium">
          {t('host.detail.hints')}
        </h3>
        {released.length ? (
          <ol className="flex flex-col gap-2 text-sm">
            {released.map((h) => (
              <li key={h.id} className="rounded-md border p-2">
                <p>{h.text}</p>
                <p className="text-muted-foreground text-xs">
                  {sourceText(t, team.paidHintIds.includes(h.id), hintSources?.[h.id], h.penaltyS)}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">{t('host.detail.noHints')}</p>
        )}
        {team.hintPenaltyS > 0 ? (
          <p className="text-sm">
            {t('host.detail.penalty', { time: formatDelta(team.hintPenaltyS * 1000) })}
          </p>
        ) : null}
        {current ? (
          next ? (
            <div className="bg-muted/50 rounded-md p-2 text-sm">
              <p className="text-xs font-medium">
                {t('host.detail.nextHint', { seconds: next.penaltyS })}
              </p>
              <p>{next.text}</p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t('host.detail.noHintsLeft')}</p>
          )
        ) : null}
      </section>

      <section aria-labelledby={`players-${team.id}`} className="flex flex-col gap-2">
        <h3 id={`players-${team.id}`} className="font-medium">
          {t('host.detail.players')}
        </h3>
        {team.members.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {team.members.map((m) => (
              <li key={m.playerId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.nickname}</span>
                {roles && m.roles.length ? (
                  <span className="text-muted-foreground">{m.roles.map(roleName).join(', ')}</span>
                ) : null}
                {!m.connected ? (
                  <span className="text-warning-text flex items-center gap-1 text-xs">
                    <WifiOff className="size-3.5" aria-hidden />
                    {t('host.board.offline')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t('host.detail.noPlayers')}</p>
        )}
        <p className="text-sm">{t('host.detail.wrong', { count: team.wrong })}</p>
      </section>

      {current ? (
        <Disclosure title={t('host.detail.clues')}>
          {current.stage.clues.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {current.stage.clues.map((c) => (
                <li key={c.id} className="flex flex-col gap-1">
                  <Badge variant="muted" className="self-start">
                    {c.roleId ? roleName(c.roleId) : t('host.detail.clueEveryone')}
                  </Badge>
                  <ClueBody kind={c.kind} body={c.body} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">{t('host.detail.noClues')}</p>
          )}
        </Disclosure>
      ) : null}
    </div>
  );
}

/**
 * The picked team's detail: a side column on a laptop, a sheet on a tablet. Closing
 * the sheet (its button, Escape, the backdrop) gives the focus back to the team's
 * card in the grid.
 */
export function TeamDetailPanel({
  outline,
  team,
  hintSources,
  commands,
  onClose,
}: {
  outline: EscapeHostOutline;
  team: EscapeHostTeam | null;
  hintSources?: Record<string, HintSource>;
  commands: HostCommands;
  onClose: () => void;
}) {
  const laptop = useMediaQuery(LAPTOP);
  if (!team) return null;
  const detail = (
    <TeamDetail outline={outline} team={team} hintSources={hintSources} commands={commands} />
  );
  if (laptop) {
    return (
      <aside aria-label={team.name} className="w-full shrink-0 lg:w-96">
        <div className="rounded-lg border p-4">{detail}</div>
      </aside>
    );
  }
  const close = () => {
    const id = team.id;
    onClose();
    // Once the sheet is gone: back on the card it was opened from.
    setTimeout(() => document.querySelector<HTMLElement>(`[data-team-card="${id}"]`)?.focus(), 0);
  };
  return (
    <Drawer open title={team.name} onClose={close}>
      {detail}
    </Drawer>
  );
}
