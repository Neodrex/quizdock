import { fireEvent, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import { drawEn, lock, state } from '../test-fixtures';
import { CombinedLock } from './combined-lock';

const roles = [
  { id: 'look', name: 'Lookout', description: '' },
  { id: 'safe', name: 'Safecracker', description: '' },
  { id: 'hack', name: 'Hacker', description: '' },
];
const duo = (over: Parameters<typeof lock>[0] = {}) =>
  lock({
    id: 'duo',
    kind: 'combined',
    label: 'Twin dials',
    partRoles: ['look', 'safe', 'hack'],
    myParts: [],
    partsDone: [],
    ...over,
  });
const en = i18n.cloneInstance({ lng: 'en' });

describe('CombinedLock', () => {
  it('one part per role of mine, each with its own input, sending its roleId', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'part-accepted' });
    drawEn(
      <CombinedLock
        lock={duo({ myParts: ['look', 'hack'] })}
        roles={roles}
        block={null}
        submit={submit}
      />,
    );
    const look = screen.getByRole('textbox', { name: 'Lookout part' });
    const hack = screen.getByRole('textbox', { name: 'Hacker part' });
    fireEvent.change(hack, { target: { value: ' 77 ' } });
    fireEvent.change(look, { target: { value: 'north' } });
    const [openLook, openHack] = screen.getAllByRole('button', { name: 'Open' });
    fireEvent.click(openHack);
    expect(submit).toHaveBeenCalledWith('duo', '77', 'hack');
    fireEvent.click(openLook);
    expect(submit).toHaveBeenCalledWith('duo', 'north', 'look');
  });

  it("parts in show as done for everyone, mine or a teammate's, by role name", () => {
    drawEn(
      <CombinedLock
        lock={duo({ myParts: ['look'], partsDone: ['look', 'safe'] })}
        roles={roles}
        block={null}
        submit={vi.fn()}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Lookout: entered')).toBeInTheDocument();
    expect(screen.getByText('Safecracker: entered')).toBeInTheDocument();
    expect(screen.getByText('Waiting for: Hacker')).toBeInTheDocument();
  });

  it('a player with no part sees the roles still missing', () => {
    drawEn(
      <CombinedLock
        lock={duo({ partsDone: ['hack'] })}
        roles={roles}
        block={null}
        submit={vi.fn()}
      />,
    );
    expect(screen.getByText('Waiting for: Lookout, Safecracker')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it("a teammate's part, from the next state, updates the list and keeps my draft", () => {
    const { rerender } = drawEn(
      <CombinedLock
        lock={duo({ myParts: ['look'] })}
        roles={roles}
        block={null}
        submit={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Lookout part' }), {
      target: { value: 'nor' },
    });
    rerender(
      <I18nextProvider i18n={en}>
        <CombinedLock
          lock={duo({ myParts: ['look'], partsDone: ['safe'] })}
          roles={roles}
          block={null}
          submit={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Safecracker: entered')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Lookout part' })).toHaveValue('nor');
    expect(screen.getByText('Waiting for: Hacker')).toBeInTheDocument();
  });

  it('not-your-part shows its text', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, reason: 'not-your-part' });
    drawEn(
      <CombinedLock lock={duo({ myParts: ['look'] })} roles={roles} block={null} submit={submit} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('This part is not yours to enter')).toBeInTheDocument();
  });

  it('works from the state fixture roles too', () => {
    const s = state();
    drawEn(
      <CombinedLock
        lock={duo({ partRoles: ['lookout', 'safe'], myParts: ['lookout'] })}
        roles={s.roles}
        block={null}
        submit={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Lookout part' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for: Safecracker')).toBeInTheDocument();
  });
});
