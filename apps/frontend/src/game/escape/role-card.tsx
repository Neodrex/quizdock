import type { EscapePlayerState } from '@quiz-dock/contracts';
import { ChevronDown, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The player's roles (roles mode), folded behind their names once read. The roles
 * come from the stage's view, or from the team before the start; parallel games
 * (no roles) show no card.
 */
export function RoleCard({ state, me }: { state: EscapePlayerState; me: string | null }) {
  const { t } = useTranslation('escape');
  if (!state.roles.length) return null;
  const ids = state.view?.roles ?? state.team?.members.find((m) => m.playerId === me)?.roles ?? [];
  const mine = ids
    .map((id) => state.roles.find((r) => r.id === id))
    .filter((r): r is EscapePlayerState['roles'][number] => !!r);
  if (!mine.length) {
    return (
      <p className="bg-card text-muted-foreground flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
        <UserRound aria-hidden className="size-4 shrink-0" />
        {t('role.later')}
      </p>
    );
  }
  return (
    <details open className="bg-card group rounded-lg border">
      <summary className="focus-visible:ring-ring flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-4 font-semibold focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <UserRound aria-hidden className="text-primary size-4 shrink-0" />
        <span className="flex-1">{t('role.title')}</span>
        <ChevronDown
          aria-hidden
          className="text-muted-foreground size-4 transition-transform group-open:rotate-180"
        />
      </summary>
      <dl className="flex flex-col gap-3 px-4 pb-4">
        {mine.map((r) => (
          <div key={r.id}>
            <dt className="font-semibold">{r.name}</dt>
            <dd className="text-muted-foreground text-sm">{r.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
