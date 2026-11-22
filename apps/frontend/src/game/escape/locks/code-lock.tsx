import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { LockCard, LockForm, type LockProps } from './lock-card';

/** Shared by code and phrase inputs: tall, 16 px text (no iOS zoom). */
export const ANSWER_INPUT = 'h-12 text-base';

/** A code: sent trimmed; a number pad when the code is digits only. */
export function CodeLock({ lock, block, submit }: LockProps) {
  const { t } = useTranslation('escape');
  const [draft, setDraft] = useState('');
  return (
    <LockCard lock={lock}>
      <LockForm
        lock={lock}
        block={block}
        ready={draft.trim() !== ''}
        send={() => submit(lock.id, draft.trim())}
      >
        {(disabled) => (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={disabled}
            aria-label={t('lock.answerFor', { lock: lock.label })}
            inputMode={lock.digits ? 'numeric' : 'text'}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={`${ANSWER_INPUT} font-mono tracking-widest`}
          />
        )}
      </LockForm>
    </LockCard>
  );
}
