import type { EscapeTemplate } from './escape.types';

/** A small valid roles-mode template: two stages, a code and a combined lock, then a phrase. */
export const tpl: EscapeTemplate = {
  id: 't',
  title: 'T',
  intro: '',
  difficulty: 'standard',
  targetMinutes: 35,
  mode: 'roles',
  roles: [
    { id: 'nav', name: 'Navigator', description: '' },
    { id: 'dec', name: 'Decoder', description: '' },
  ],
  stages: [
    {
      id: 's1',
      title: 'One',
      intro: '',
      clues: [],
      hints: [],
      unlockText: '',
      locks: [
        { id: 'safe', label: 'Safe', kind: 'code', answer: '1234' },
        {
          id: 'duo',
          label: 'Duo',
          kind: 'combined',
          parts: [
            { roleId: 'nav', answer: 'north' },
            { roleId: 'dec', answer: '42' },
          ],
        },
      ],
    },
    {
      id: 's2',
      title: 'Two',
      intro: '',
      clues: [],
      hints: [],
      unlockText: '',
      locks: [{ id: 'word', label: 'Word', kind: 'phrase', answers: ['out'] }],
    },
  ],
  finale: '',
};
