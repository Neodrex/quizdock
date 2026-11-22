import type { EscapePlayerView } from '@quiz-dock/contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClueList, mediaSrc } from './clue-list';
import { drawEn, state, view } from './test-fixtures';

type Clue = EscapePlayerView['clues'][number];
const clue = (over: Partial<Clue>): Clue => ({
  id: 'c1',
  roleId: null,
  kind: 'text',
  body: 'A note',
  ...over,
});

const draw = (clues: Clue[]) => {
  const s = state({ view: view({ clues }) });
  return drawEn(<ClueList view={s.view!} roles={s.roles} />);
};

describe('mediaSrc', () => {
  it('takes the app media path and https, nothing else', () => {
    expect(mediaSrc('/api/v1/media/01HZY8K7X4N5Q6R7S8T9V0W1X2')).toBe(
      '/api/v1/media/01HZY8K7X4N5Q6R7S8T9V0W1X2',
    );
    expect(mediaSrc(' https://cdn.example.org/a.png ')).toBe('https://cdn.example.org/a.png');
    expect(mediaSrc('http://example.org/a.png')).toBeNull();
    expect(mediaSrc('javascript:alert(1)')).toBeNull();
    expect(mediaSrc('//evil.example/a.png')).toBeNull();
    expect(mediaSrc('/api/v1/media/../auth/me')).toBeNull();
    expect(mediaSrc('/other/path')).toBeNull();
    expect(mediaSrc('Look under the rug')).toBeNull();
  });
});

describe('ClueList', () => {
  it('lists shared clues and my role clues under My clues, tagged with the role name', () => {
    draw([
      clue({ id: 'a', body: 'Shared note' }),
      clue({ id: 'b', roleId: 'lookout', body: 'Guard at 9' }),
    ]);
    const region = screen.getByRole('region', { name: 'My clues' });
    const [shared, mine] = within(region).getAllByRole('listitem');
    expect(shared).toHaveTextContent('Shared note');
    expect(shared).toHaveTextContent('Everyone');
    expect(mine).toHaveTextContent('Guard at 9');
    expect(mine).toHaveTextContent('Lookout');
  });

  it('renders text through Markdown, links unwrapped', () => {
    draw([clue({ body: '**Bold** and [a link](https://evil.example)' })]);
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText(/a link/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('media clues: an image with alt, audio with controls, a document link', () => {
    const { container } = draw([
      clue({ id: 'i', kind: 'image', body: 'https://cdn.example.org/map.png' }),
      clue({ id: 'a', kind: 'audio', body: '/api/v1/media/01HZY8K7X4N5Q6R7S8T9V0W1X2' }),
      clue({ id: 'd', kind: 'document', body: 'https://cdn.example.org/letter.pdf' }),
    ]);
    const img = screen.getByRole('img', { name: 'The vault door, clue 1' });
    expect(img).toHaveAttribute('src', 'https://cdn.example.org/map.png');
    const audio = container.querySelector('audio')!;
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/api/v1/media/01HZY8K7X4N5Q6R7S8T9V0W1X2');
    const link = screen.getByRole('link', { name: /Open the document/ });
    expect(link).toHaveAttribute('href', 'https://cdn.example.org/letter.pdf');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('a media clue with any other body shows as text', () => {
    const { container } = draw([
      clue({ kind: 'image', body: 'javascript:alert(1)' }),
      clue({ id: 'b', kind: 'audio', body: 'Hum the tune' }),
    ]);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.getByText('Hum the tune')).toBeInTheDocument();
  });

  it('says so when there is no clue', () => {
    draw([]);
    expect(screen.getByText('No clues for you on this stage')).toBeInTheDocument();
  });
});
