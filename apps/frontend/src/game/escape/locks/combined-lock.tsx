import type { EscapePlayerState } from '@quiz-dock/contracts';
import { Check, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ANSWER_INPUT } from './code-lock';
import { LockCard, LockForm, type LockProps } from './lock-card';

/**
 * A combined lock (roles mode): one part per role, each entered by a holder of that
 * role. The phone shows an input for each part of mine still open, the parts already
 * in (anyone's), and the roles the team still waits for.
 */
export function CombinedLock({
  lock,
  block,
  submit,
  roles,
}: LockProps & { roles: EscapePlayerState['roles'] }) {
  const { t } = useTranslation('escape');
  const name = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const mine = lock.myParts ?? [];
  const done = lock.partsDone ?? [];
  // Every part's role, in the template's order (an older server: mine and the ones in).
  const all = lock.partRoles ?? [...new Set([...mine, ...done])];
  const open = all.filter((r) => !done.includes(r) && mine.includes(r));
  const waiting = all.filter((r) => !done.includes(r) && !mine.includes(r));
  return (
    <LockCard lock={lock}>
      <div className="flex flex-col gap-3">
        {done.length > 0 && (
          <ul className="flex flex-col gap-1">
            {all
              .filter((r) => done.includes(r))
              .map((r) => (
                <li key={r} className="text-success flex items-center gap-2 text-sm font-medium">
                  <Check aria-hidden className="size-4" />
                  {t('lock.partDone', { role: name(r) })}
                </li>
              ))}
          </ul>
        )}
        {open.map((r) => (
          <PartForm
            key={r}
            roleId={r}
            roleName={name(r)}
            lock={lock}
            block={block}
            submit={submit}
          />
        ))}
        {waiting.length > 0 && (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Hourglass aria-hidden className="size-4 shrink-0" />
            {t('lock.waitingFor', { roles: waiting.map(name).join(', ') })}
          </p>
        )}
      </div>
    </LockCard>
  );
}

function PartForm({
  roleId,
  roleName,
  lock,
  block,
  submit,
}: LockProps & { roleId: string; roleName: string }) {
  const { t } = useTranslation('escape');
  const [draft, setDraft] = useState('');
  return (
    <LockForm
      lock={lock}
      block={block}
      ready={draft.trim() !== ''}
      send={() => submit(lock.id, draft.trim(), roleId)}
    >
      {(disabled) => (
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          aria-label={t('lock.partFor', { role: roleName })}
          placeholder={t('lock.partFor', { role: roleName })}
          autoComplete="off"
          spellCheck={false}
          className={ANSWER_INPUT}
        />
      )}
    </LockForm>
  );
}
