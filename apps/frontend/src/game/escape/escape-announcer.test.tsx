import { act, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { loadNamespace } from '../../i18n/content-language';
import { EscapeAnnouncer, MAX_WAITING, SAY_MS } from './escape-announcer';
import type { Announcement } from './escape-reducer';

const en = i18n.cloneInstance({ lng: 'en' });
const msg = (id: number, key: string, params?: Announcement['params']): Announcement => ({
  id,
  key,
  ...(params ? { params } : {}),
});

function draw(polite: Announcement[], assertive: Announcement | null = null, lang = en) {
  const ui = (p: Announcement[], a: Announcement | null) => (
    <I18nextProvider i18n={lang}>
      <EscapeAnnouncer polite={p} assertive={a} />
    </I18nextProvider>
  );
  const r = render(ui(polite, assertive));
  return {
    ...r,
    update: (p: Announcement[], a: Announcement | null = null) => r.rerender(ui(p, a)),
  };
}

const politeRegion = () => screen.getByRole('status');
const assertiveRegion = () => screen.getByTestId('escape-assertive');

describe('EscapeAnnouncer', () => {
  beforeAll(() => loadNamespace('de', 'escape'));
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('has both regions mounted before any message', () => {
    draw([]);
    expect(politeRegion()).toHaveAttribute('aria-live', 'polite');
    expect(politeRegion()).toBeEmptyDOMElement();
    expect(assertiveRegion()).toHaveAttribute('aria-live', 'assertive');
    expect(assertiveRegion()).toBeEmptyDOMElement();
  });

  it('says polite messages one at a time, each for at least a second, until the queue drains', () => {
    const { update } = draw([]);
    update([
      msg(1, 'announce.lockSolved', { lock: 'Keypad', by: 'Ben' }),
      msg(2, 'announce.hintFree'),
    ]);
    wait(0);
    expect(politeRegion()).toHaveTextContent('Ben opened Keypad');
    wait(SAY_MS - 1);
    expect(politeRegion()).toHaveTextContent('Ben opened Keypad');
    wait(SAY_MS);
    expect(politeRegion()).toHaveTextContent('A free hint arrived');
    // A message coming later joins the queue; the ones already said are not said again.
    update([
      msg(1, 'announce.lockSolved', { lock: 'Keypad', by: 'Ben' }),
      msg(2, 'announce.hintFree'),
      msg(3, 'announce.resumed'),
    ]);
    wait(SAY_MS * 2);
    expect(politeRegion()).toHaveTextContent('The game is back on');
    wait(SAY_MS * 2);
    expect(politeRegion()).toBeEmptyDOMElement();
  });

  it('shows the latest warning in the assertive region', () => {
    const { update } = draw([], msg(1, 'announce.minutesLeft', { count: 5 }));
    expect(assertiveRegion()).toHaveTextContent('5 minutes left');
    update([], msg(2, 'announce.minutesLeft', { count: 1 }));
    expect(assertiveRegion()).toHaveTextContent('1 minute left');
    update([], msg(3, 'announce.timeUp'));
    expect(assertiveRegion()).toHaveTextContent("Time's up!");
  });

  it('speaks the audience language', () => {
    draw(
      [msg(1, 'announce.started')],
      msg(2, 'announce.timeUp'),
      i18n.cloneInstance({ lng: 'de' }),
    );
    wait(0);
    expect(politeRegion()).toHaveTextContent('Das Spiel beginnt. Viel Glück!');
    expect(assertiveRegion()).toHaveTextContent('Die Zeit ist um!');
  });

  it('keeps at most a few waiting, and says a teammate’s repeated wrong tries once', () => {
    const { update } = draw([]);
    const wrong = (id: number) => msg(id, 'announce.teammateWrong', { by: 'Ben' });
    update([msg(1, 'announce.started'), wrong(2), wrong(3), wrong(4)]);
    wait(0);
    expect(politeRegion()).toHaveTextContent('The run has started');
    wait(SAY_MS);
    expect(politeRegion()).toHaveTextContent('Ben tried a wrong answer');
    wait(SAY_MS);
    expect(politeRegion()).toBeEmptyDOMElement();
    // A burst: only the newest MAX_WAITING wait, the oldest go.
    update(
      Array.from({ length: 12 }, (_, i) =>
        msg(10 + i, 'announce.lockSolved', { lock: `L${i}`, by: 'Ana' }),
      ),
    );
    const said: string[] = [];
    for (let i = 0; i < 12; i++) {
      wait(0);
      said.push(politeRegion().textContent ?? '');
      wait(SAY_MS);
    }
    expect(said.filter(Boolean)).toHaveLength(1 + MAX_WAITING);
    expect(said[0]).toBe('Ana opened L0');
    expect(said.filter(Boolean).at(-1)).toBe('Ana opened L11');
  });
});
