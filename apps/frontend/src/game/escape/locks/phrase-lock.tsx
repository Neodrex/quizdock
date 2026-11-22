import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ANSWER_INPUT } from './code-lock';
import { LockCard, LockForm, type LockProps } from './lock-card';

/** A phrase: sent as typed, the server normalises case, accents and spacing. */
export function PhraseLock({ lock, block, submit }: LockProps) {
  const { t } = useTranslation('escape');
  const [draft, setDraft] = useState('');
  return (
    <LockCard lock={lock}>
      <LockForm
        lock={lock}
        block={block}
        ready={draft.trim() !== ''}
        send={() => submit(lock.id, draft)}
      >
        {(disabled) => (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={disabled}
            aria-label={t('lock.answerFor', { lock: lock.label })}
            autoComplete="off"
            className={ANSWER_INPUT}
          />
        )}
      </LockForm>
    </LockCard>
  );
}
