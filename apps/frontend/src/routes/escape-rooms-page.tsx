import type { ParticipantAccess } from '@quiz-dock/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { DoorOpen, Play, Send, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListSkeleton, LoadFailed } from '@/components/ui/loading';
import { PageTitle } from '@/components/ui/page-title';
import { cn } from '@/lib/utils';
import {
  getEscapeTemplatesControllerListQueryKey,
  useEscapeTemplatesControllerList,
} from '../api/generated/escape-templates/escape-templates';
import type { EscapeTemplateListItemDto } from '../api/generated/model';
import { apiErrorText } from '../api/http';
import { meControllerGetPreferences, meControllerUpdatePreferences } from '../api/generated/me/me';
import { getAuthMode } from '../auth/auth-context';
import { allowsAnonymousParticipants } from '../config';
import { type EscapeRoomOptions, createEscapeRoom } from '../game/escape/host/host-client';
import { addSampleRooms, canLaunch, publishRoom } from '../game/escape/host/host-templates';
import { LaunchAccessDialog } from '../game/launch-access-dialog';

/**
 * Opens a room and goes to its console. Runs from the click handler, never from an
 * effect (StrictMode would open two rooms), and once at a time: a second click while
 * one is opening does nothing. Under OIDC with open access offered, it asks how
 * players get in first, unless the host remembered a choice (as `useLaunchSession`).
 */
function useOpenRoom() {
  const { t } = useTranslation('live');
  const navigate = useNavigate();
  const busyRef = useRef(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const start = async (id: string, options: EscapeRoomOptions) => {
    setOpening(id);
    try {
      const { pin } = await createEscapeRoom(id, options);
      await navigate({ to: '/session/$pin/console', params: { pin } });
    } catch (e) {
      setError({ id, text: e instanceof Error ? e.message : t('errors.launchFailed') });
    } finally {
      busyRef.current = false;
      setOpening(null);
    }
  };

  const open = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    if (getAuthMode() !== 'oidc' || !allowsAnonymousParticipants()) return start(id, {});
    // Unreadable preferences only cost the shortcut: the dialog asks.
    const remembered = await meControllerGetPreferences()
      .then((res) => res.data.participantAccess)
      .catch(() => undefined);
    if (remembered) return start(id, { participantAccess: remembered });
    setAsking(id);
  };

  const onConfirm = (access: ParticipantAccess, remember: boolean) => {
    if (!asking) return;
    const id = asking;
    setAsking(null);
    if (remember) {
      void meControllerUpdatePreferences({ participantAccess: access }).catch(() => undefined);
    }
    void start(id, { participantAccess: access });
  };

  const dialog = (
    <LaunchAccessDialog
      open={asking !== null}
      onConfirm={onConfirm}
      onCancel={() => {
        setAsking(null);
        busyRef.current = false;
      }}
    />
  );

  return { open, opening, error, dialog };
}

/**
 * The Create handler: a template that cannot be launched (a draft, or a row the
 * server cannot read) opens nothing, even if its disabled button is clicked anyway.
 */
export function openIfLaunchable(
  r: EscapeTemplateListItemDto,
  open: (id: string) => Promise<void>,
): () => void {
  return () => {
    if (!canLaunch(r)) return;
    void open(r.id);
  };
}

/** /escape: the host's escape templates; a published one opens a room (M5 Task 5.8). */
export function EscapeRoomsPage() {
  const { t } = useTranslation('escape');
  const queryClient = useQueryClient();
  // The list only: no content, so no answers (owner question 1).
  const list = useEscapeTemplatesControllerList();
  const rooms = list.data?.data ?? [];
  const room = useOpenRoom();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<{ id: string; text: string } | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getEscapeTemplatesControllerListQueryKey() });

  const onAddSamples = async () => {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await addSampleRooms();
      await refresh();
    } catch (e) {
      setAddError(apiErrorText(e, t('host.rooms.addSamplesFailed')));
    } finally {
      setAdding(false);
    }
  };

  const onPublish = async (id: string) => {
    if (publishing) return;
    setPublishing(id);
    setPublishError(null);
    try {
      await publishRoom(id);
      await refresh();
    } catch (e) {
      setPublishError({ id, text: apiErrorText(e) });
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <PageTitle>{t('host.nav')}</PageTitle>
        <p className="text-muted-foreground">{t('host.rooms.intro')}</p>
      </header>
      {room.dialog}

      {list.isLoading ? <ListSkeleton rows={3} variant="grid" /> : null}
      {list.error ? <LoadFailed error={list.error} onRetry={() => void list.refetch()} /> : null}

      {!list.isLoading && !list.error && rooms.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          size="large"
          title={t('host.rooms.empty')}
          action={
            <div className="flex flex-col items-center gap-2">
              <Button
                type="button"
                className="min-h-11"
                onClick={() => void onAddSamples()}
                disabled={adding}
                aria-busy={adding}
              >
                <Sparkles className="size-4" aria-hidden />
                {t('host.rooms.addSamples')}
              </Button>
              {addError ? (
                <p role="alert" className="text-destructive text-sm">
                  {addError}
                </p>
              ) : null}
            </div>
          }
        >
          {t('host.rooms.emptyHint')}
        </EmptyState>
      ) : null}

      {rooms.length > 0 ? (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((r) => (
            <li key={r.id} className="flex">
              <RoomCard
                room={r}
                opening={room.opening === r.id}
                busy={room.opening !== null}
                publishing={publishing === r.id}
                error={
                  (room.error?.id === r.id ? room.error.text : null) ??
                  (publishError?.id === r.id ? publishError.text : null)
                }
                onOpen={openIfLaunchable(r, room.open)}
                onPublish={() => void onPublish(r.id)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RoomCard({
  room: r,
  opening,
  busy,
  publishing,
  error,
  onOpen,
  onPublish,
}: {
  room: EscapeTemplateListItemDto;
  opening: boolean;
  busy: boolean;
  publishing: boolean;
  error: string | null;
  onOpen: () => void;
  onPublish: () => void;
}) {
  const { t } = useTranslation('escape');
  const launchable = canLaunch(r);
  const unreadable = r.mode === null;
  const titleId = `escape-room-${r.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className="bg-card flex w-full flex-col gap-3 rounded-lg border p-4"
    >
      <div className={cn('flex flex-col gap-2', !launchable && 'opacity-60')}>
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold break-words">
            {r.title}
          </h2>
          <Badge variant={r.status === 'published' ? 'success' : 'muted'}>
            {t(
              r.status === 'published' ? 'host.rooms.status.published' : 'host.rooms.status.draft',
            )}
          </Badge>
        </div>
        {r.mode ? (
          <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <li>{t(r.mode === 'roles' ? 'host.rooms.mode.roles' : 'host.rooms.mode.parallel')}</li>
            {r.difficulty ? (
              <li>
                {t(
                  r.difficulty === 'hard'
                    ? 'host.rooms.difficulty.hard'
                    : 'host.rooms.difficulty.standard',
                )}
              </li>
            ) : null}
            {r.targetMinutes !== null ? (
              <li>{t('host.rooms.minutes', { minutes: r.targetMinutes })}</li>
            ) : null}
            {r.stageCount !== null ? (
              <li>{t('host.rooms.stages', { stages: r.stageCount })}</li>
            ) : null}
          </ul>
        ) : null}
        {/* The length is the template's (owner question 5): shown, never asked. */}
        {launchable && r.targetMinutes !== null ? (
          <p className="text-sm">{t('host.rooms.length', { minutes: r.targetMinutes })}</p>
        ) : null}
        {unreadable ? (
          <p className="text-sm">{t('host.rooms.unreadable')}</p>
        ) : !launchable ? (
          <p className="text-sm font-medium">{t('host.rooms.publishFirst')}</p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button
          type="button"
          variant="main-action"
          size="lg"
          className="min-h-12"
          onClick={onOpen}
          disabled={!launchable || busy}
          aria-busy={opening}
        >
          <Play className="size-4" aria-hidden />
          {opening ? t('host.rooms.creating') : t('host.rooms.create')}
        </Button>
        {!launchable && !unreadable ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onPublish}
            disabled={publishing}
            aria-busy={publishing}
          >
            <Send className="size-4" aria-hidden />
            {t('host.rooms.publish')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </article>
  );
}
