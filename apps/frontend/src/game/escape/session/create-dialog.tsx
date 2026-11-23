import type { EscapeSessionType } from '@quiz-dock/contracts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useEscapeLicencesControllerList } from '../../../api/generated/escape-licences/escape-licences';
import type { EscapeLicenceSummaryDto } from '../../../api/generated/model';
import { serverNow } from '../../clock';

/** What the host picked: the session fields of `escape:create`. */
export interface SessionChoice {
  sessionType: EscapeSessionType;
  licenceId?: string;
  race?: { format: 'solo' | 'teams'; startsAt?: number };
}

/** The dialog's rule for a scheduled race; the server's (`escape.race_start_out_of_range`) wins. */
export const RACE_LEAD_MIN = 1;
export const RACE_LEAD_MAX = 180;

const TYPES: EscapeSessionType[] = ['group', 'race', 'hosted'];

/** "Acme · 8 players · 2 events left · until 31 Dec" */
export function licenceLine(
  l: EscapeLicenceSummaryDto,
  t: (k: string, o?: Record<string, unknown>) => string,
  lang: string,
): string {
  const date = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(
    new Date(l.expiresAt),
  );
  return t('session.create.licenceLine', {
    name: l.organisationName ?? t('session.create.unnamed'),
    players: t('session.create.players', { count: l.participantCap }),
    events:
      l.eventsLeft === null
        ? t('session.create.annual')
        : t('session.create.eventsLeft', { count: l.eventsLeft }),
    date,
  });
}

/**
 * How the room is played (M7 §1.1): group play, a race or a hosted event. A roles
 * template is hosted only. A hosted event runs under one of the host's licences
 * (`GET /escape-licences`); a race is solo or in teams, started by the host or on
 * its own 1 to 180 minutes ahead. The create runs from here: a refusal stays in the
 * dialog with its text.
 */
export function CreateSessionDialog({
  open,
  template,
  onCreate,
  onCancel,
}: {
  open: boolean;
  template: { title: string; mode: 'roles' | 'parallel' | null };
  /** Rejects with the refusal's text. */
  onCreate: (choice: SessionChoice) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation('escape');
  const rolesOnly = template.mode === 'roles';
  const [type, setType] = useState<EscapeSessionType>(rolesOnly ? 'hosted' : 'group');
  const [licenceId, setLicenceId] = useState('');
  const [format, setFormat] = useState<'solo' | 'teams'>('solo');
  const [scheduled, setScheduled] = useState(false);
  const [minutes, setMinutes] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Each opening starts over.
  useEffect(() => {
    if (!open) return;
    setType(rolesOnly ? 'hosted' : 'group');
    setLicenceId('');
    setFormat('solo');
    setScheduled(false);
    setMinutes('10');
    setError(null);
  }, [open, rolesOnly]);

  const list = useEscapeLicencesControllerList({ query: { enabled: open } });
  const licences = list.data?.data ?? [];
  // One licence: preselected.
  const chosen = licenceId || (licences.length === 1 ? licences[0].id : '');

  const lead = Number(minutes);
  const leadOk = Number.isInteger(lead) && lead >= RACE_LEAD_MIN && lead <= RACE_LEAD_MAX;
  const ready = type === 'hosted' ? chosen !== '' : type === 'race' ? !scheduled || leadOk : true;

  const submit = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const choice: SessionChoice =
      type === 'hosted'
        ? { sessionType: 'hosted', licenceId: chosen }
        : type === 'race'
          ? {
              sessionType: 'race',
              race: { format, ...(scheduled ? { startsAt: serverNow() + lead * 60_000 } : {}) },
            }
          : { sessionType: 'group' };
    try {
      await onCreate(choice);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('session.create.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const radio = (
    name: string,
    checked: boolean,
    onChange: () => void,
    label: string,
    hint: string,
    disabled = false,
  ) => (
    <label
      key={`${name}-${label}`}
      className={cn(
        'flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm',
        checked && 'border-primary bg-primary/5',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name={name}
        className="accent-primary mt-1"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground block">{hint}</span>
      </span>
    </label>
  );

  return (
    <ConfirmDialog
      open={open}
      wide
      title={t('session.create.title', { title: template.title })}
      confirmLabel={busy ? t('session.create.creating') : t('session.create.submit')}
      confirmDisabled={!ready || busy}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <div role="radiogroup" aria-label={t('session.create.type')} className="flex flex-col gap-2">
        {TYPES.map((k) =>
          radio(
            'session-type',
            type === k,
            () => setType(k),
            t(`session.create.${k}.label`),
            t(`session.create.${k}.hint`),
            rolesOnly && k !== 'hosted',
          ),
        )}
        {rolesOnly && (
          <p className="text-muted-foreground text-sm">{t('session.create.rolesOnly')}</p>
        )}
      </div>

      {type === 'hosted' &&
        (list.isLoading ? (
          <p className="text-muted-foreground text-sm">{t('session.create.licenceLoading')}</p>
        ) : licences.length === 0 ? (
          <p className="text-sm font-medium">{t('session.create.noLicence')}</p>
        ) : (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('session.create.licence')}
            <select
              className="border-input bg-background min-h-11 rounded-md border px-3"
              value={chosen}
              onChange={(e) => setLicenceId(e.target.value)}
            >
              {licences.length > 1 && <option value="">{t('session.create.pickLicence')}</option>}
              {licences.map((l) => (
                <option key={l.id} value={l.id}>
                  {licenceLine(l, t, i18n.language)}
                </option>
              ))}
            </select>
          </label>
        ))}

      {type === 'race' && (
        <>
          <div
            role="radiogroup"
            aria-label={t('session.create.format')}
            className="flex flex-col gap-2"
          >
            {(['solo', 'teams'] as const).map((f) =>
              radio(
                'race-format',
                format === f,
                () => setFormat(f),
                t(`session.create.${f}.label`),
                t(`session.create.${f}.hint`),
              ),
            )}
          </div>
          <div
            role="radiogroup"
            aria-label={t('session.create.start')}
            className="flex flex-col gap-2"
          >
            {radio(
              'race-start',
              !scheduled,
              () => setScheduled(false),
              t('session.create.startByHost'),
              t('session.create.startByHostHint'),
            )}
            {radio(
              'race-start',
              scheduled,
              () => setScheduled(true),
              t('session.create.startAt'),
              t('session.create.startAtHint'),
            )}
          </div>
          {scheduled && (
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('session.create.startIn')}
                <Input
                  type="number"
                  inputMode="numeric"
                  min={RACE_LEAD_MIN}
                  max={RACE_LEAD_MAX}
                  step={1}
                  className="min-h-11"
                  value={minutes}
                  aria-invalid={!leadOk || undefined}
                  aria-describedby="race-lead-hint"
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
              <span
                id="race-lead-hint"
                className={cn(
                  'text-xs font-normal',
                  leadOk ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {t('session.create.startRange', { min: RACE_LEAD_MIN, max: RACE_LEAD_MAX })}
              </span>
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
