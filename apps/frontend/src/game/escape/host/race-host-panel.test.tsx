import type { EscapeHostSession } from '@quiz-dock/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { drawEn } from '../test-fixtures';
import { RaceSiteNotice } from './race-host-panel';

const PIN = '123456';
const race = (over: Partial<NonNullable<EscapeHostSession['race']>> = {}): EscapeHostSession => ({
  type: 'race',
  cap: 500,
  joined: 0,
  race: { format: 'solo', startsAt: null, started: false, ...over },
  licence: null,
  tools: [],
});

describe('RaceSiteNotice (M9 Task 9.6)', () => {
  it('the Site does not know the room yet: the notice names the PIN to paste', () => {
    drawEn(<RaceSiteNotice pin={PIN} session={race({ siteLinked: false })} />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('The Site does not know this room yet.');
    expect(note).toHaveTextContent(`paste the PIN ${PIN} in /admin/races`);
  });

  it('another room opened the race on the Site: its results will not reach the archive', () => {
    drawEn(<RaceSiteNotice pin={PIN} session={race({ siteLinked: false, siteLost: true })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Another room opened this race on the Site; its results will not reach the archive.',
    );
    expect(screen.queryByText(/paste the PIN/)).toBeNull();
  });

  it('nothing for a linked Site race or a race not from the Site', () => {
    for (const session of [race({ siteLinked: true }), race()]) {
      const { container, unmount } = drawEn(<RaceSiteNotice pin={PIN} session={session} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
