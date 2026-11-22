import type { EscapePlayerState, EscapePlayerView } from '@quiz-dock/contracts';
import { FileText, SearchX } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '@/components/markdown';
import { MEDIA_PATH } from '@/lib/media-url';

type Clue = EscapePlayerView['clues'][number];

/**
 * A media clue's address, or null when its body is not one (owner question 2): a file
 * this app serves (`/api/v1/media/…`, no way out of that path) or an `https://` URL.
 * Anything else is shown as text.
 */
export function mediaSrc(body: string): string | null {
  const s = body.trim();
  if (s.startsWith(MEDIA_PATH)) {
    const rest = s.slice(MEDIA_PATH.length);
    return /^[A-Za-z0-9_-]+$/.test(rest) ? s : null;
  }
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && !/\s/.test(s) ? url.href : null;
  } catch {
    return null;
  }
}

/** The clues this phone may read on the stage: shared ones and the ones of its roles. */
export function ClueList({
  view,
  roles,
}: {
  view: EscapePlayerView;
  roles: EscapePlayerState['roles'];
}) {
  const { t } = useTranslation('escape');
  const headingId = useId();
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-semibold">
        {t('clues.title')}
      </h2>
      {view.clues.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm">
          <SearchX aria-hidden className="size-4 shrink-0" />
          {t('clues.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.clues.map((c, i) => (
            <li key={c.id} className="bg-card flex flex-col gap-2 rounded-lg border p-4">
              <span className="bg-muted text-muted-foreground self-start rounded-full px-2 py-0.5 text-xs font-medium">
                {c.roleId ? roleName(c.roleId) : t('clues.everyone')}
              </span>
              <ClueBody clue={c} alt={t('clues.imageAlt', { stage: view.title, index: i + 1 })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClueBody({ clue, alt }: { clue: Clue; alt: string }) {
  const { t } = useTranslation('escape');
  const src = clue.kind === 'text' ? null : mediaSrc(clue.body);
  if (src && clue.kind === 'image') {
    return <img src={src} alt={alt} className="max-h-[60vh] w-full rounded-md object-contain" />;
  }
  if (src && clue.kind === 'audio') {
    return <audio controls preload="none" src={src} className="w-full" />;
  }
  if (src && clue.kind === 'document') {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary focus-visible:ring-ring flex min-h-12 items-center gap-2 rounded-md font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        <FileText aria-hidden className="size-5 shrink-0" />
        {t('clues.openDocument')}
      </a>
    );
  }
  return <Markdown className="text-left">{clue.body}</Markdown>;
}
