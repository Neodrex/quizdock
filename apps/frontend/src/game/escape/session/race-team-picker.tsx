import { LogIn, User, UserPlus } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** A race team code: 4 letters, no I nor O (the server's alphabet). */
export const CODE_LENGTH = 4;
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

/** What a player types, as a code: upper case, letters only, at most 4. */
export function codeInput(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, CODE_LENGTH);
}

type Choice = 'solo' | 'start' | 'join';

/**
 * A team race's choice on the phone (M7 owner question 2), for a player with no team:
 * play solo (the default: a player without a team races alone), start a team (a name,
 * then its code to share) or join one by its code. A player who came after the start
 * picks too, and "Play solo" then starts a team of one at once. Refusals show their
 * text ("This team is full", "No team has this code", "Too many tries…").
 */
export function RaceTeamPicker({
  running,
  nickname,
  newTeam,
  joinTeam,
}: {
  /** The race is on: the player has no team yet, and solo must be asked for. */
  running: boolean;
  /** The solo team's name when the race is on. */
  nickname: string;
  /** Reject with the refusal's text. */
  newTeam: (name: string) => Promise<unknown>;
  joinTeam: (code: string) => Promise<unknown>;
}) {
  const { t } = useTranslation('escape');
  const id = useId();
  const [choice, setChoice] = useState<Choice>('solo');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set before the re-render: a double tap sends one request.
  const busyRef = useRef(false);

  const run = async (go: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await go();
    } catch (e) {
      setError((e as Error).message || t('race.phone.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const trimmed = name.trim();
  const codeOk = CODE_RE.test(code);
  const options: { value: Choice; label: string; icon: typeof User }[] = [
    { value: 'solo', label: t('race.phone.solo'), icon: User },
    { value: 'start', label: t('race.phone.start'), icon: UserPlus },
    { value: 'join', label: t('race.phone.join'), icon: LogIn },
  ];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-semibold">{t('race.phone.choose')}</h2>
      {running && <p className="text-muted-foreground text-sm">{t('race.phone.late')}</p>}
      <div role="radiogroup" aria-label={t('race.phone.choose')} className="flex flex-col gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'bg-card flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-4 py-2',
              choice === o.value && 'border-primary bg-primary/5',
            )}
          >
            <input
              type="radio"
              name={`${id}-choice`}
              className="accent-primary"
              checked={choice === o.value}
              onChange={() => {
                setChoice(o.value);
                setError(null);
              }}
            />
            <o.icon aria-hidden className="text-muted-foreground size-5 shrink-0" />
            <span className="font-medium">{o.label}</span>
          </label>
        ))}
      </div>

      {choice === 'solo' &&
        (running ? (
          <Button
            type="button"
            size="lg"
            className="min-h-12"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run(() => newTeam(nickname))}
          >
            {t('race.phone.soloGo')}
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">{t('race.phone.soloDefault')}</p>
        ))}

      {choice === 'start' && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) void run(() => newTeam(trimmed));
          }}
        >
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            {t('race.phone.teamName')}
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={40}
            autoComplete="off"
            className="min-h-12 text-base"
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            className="min-h-12"
            disabled={busy || !trimmed}
            aria-busy={busy}
          >
            {t('race.phone.create')}
          </Button>
        </form>
      )}

      {choice === 'join' && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeOk) void run(() => joinTeam(code));
          }}
        >
          <label htmlFor={`${id}-code`} className="text-sm font-medium">
            {t('race.phone.codeField')}
          </label>
          <Input
            id={`${id}-code`}
            value={code}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={CODE_LENGTH}
            className="min-h-12 text-center font-mono text-2xl tracking-[0.3em] uppercase"
            onChange={(e) => setCode(codeInput(e.target.value))}
          />
          <Button
            type="submit"
            size="lg"
            className="min-h-12"
            disabled={busy || !codeOk}
            aria-busy={busy}
          >
            {t('race.phone.joinGo')}
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/** A team race team's code, large, for friends to type in. */
export function RaceTeamCode({ code }: { code: string }) {
  const { t } = useTranslation('escape');
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed p-3 text-center">
      <span className="text-muted-foreground text-sm">{t('race.phone.share')}</span>
      <span
        role="img"
        aria-label={t('race.phone.codeLabel', { letters: code.split('').join(' ') })}
        className="font-mono text-4xl font-bold tracking-[0.3em]"
      >
        {code}
      </span>
    </div>
  );
}
