import type { EscapeTemplateContent } from '@quiz-dock/contracts';

/** Parallel mode: a team is locked in an old library at closing time and finds the way out. */
export const lostLibrary: EscapeTemplateContent = {
  title: 'Lost Library',
  intro:
    'You stayed too late in the Ashford Library. The lights are off, the doors are locked, and the only way out is through the old archive.',
  difficulty: 'standard',
  targetMinutes: 30,
  mode: 'parallel',
  roles: [],
  stages: [
    {
      id: 'reading-room',
      title: 'The Reading Room',
      intro: 'Long tables, green lamps, and a card catalogue with one locked drawer.',
      locks: [
        { id: 'catalogue', label: 'Card catalogue drawer', kind: 'code', answer: '42' },
        {
          id: 'librarian',
          label: "The librarian's password",
          kind: 'phrase',
          answers: ['silence'],
        },
      ],
      clues: [
        {
          id: 'reading-slip',
          roleId: null,
          kind: 'text',
          body: 'An overdue slip on the desk: "Return the key to drawer 42."',
        },
        {
          id: 'reading-bookmark',
          roleId: null,
          kind: 'text',
          body: 'A bookmark in a forgotten novel: "The librarian\'s favourite word is the rule of this room." A sign on the wall reads SILENCE.',
        },
      ],
      hints: [
        {
          id: 'reading-h1',
          text: 'The slip names a drawer number.',
          penaltyS: 30,
          releaseAfterS: null,
        },
        {
          id: 'reading-h2',
          text: 'Look at the sign on the wall: what is the rule here?',
          penaltyS: 60,
          releaseAfterS: 480,
        },
      ],
      unlockText: 'The drawer slides open. Inside, a brass key to the stacks.',
    },
    {
      id: 'stacks',
      title: 'The Stacks',
      intro: 'Tall shelves. Three volumes lie on the floor and one book does not belong.',
      locks: [
        {
          id: 'volumes',
          label: 'Put the volumes back in order',
          kind: 'sequence',
          items: [
            { id: 'vol-3', label: 'Volume III' },
            { id: 'vol-1', label: 'Volume I' },
            { id: 'vol-2', label: 'Volume II' },
          ],
          order: ['vol-1', 'vol-2', 'vol-3'],
        },
        {
          id: 'odd-book',
          label: 'Which book is on the wrong shelf?',
          kind: 'choice',
          options: [
            { id: 'odes', label: 'Odes of the Sea', image: null },
            { id: 'sonnets', label: 'Forty Sonnets', image: null },
            { id: 'soup', label: 'One Hundred Soups', image: null },
          ],
          correct: ['soup'],
        },
        { id: 'cabinet', label: 'Locked cabinet', kind: 'code', answer: '821' },
      ],
      clues: [
        {
          id: 'stacks-label',
          roleId: null,
          kind: 'text',
          body: 'The shelf label: "Poetry. Volumes in number order, lowest first."',
        },
        {
          id: 'stacks-cabinet',
          roleId: null,
          kind: 'text',
          body: 'The cabinet plate: "English poetry, Dewey number 821." Every book here should be a book of poems.',
        },
      ],
      hints: [
        { id: 'stacks-h1', text: 'Volume I comes first.', penaltyS: 30, releaseAfterS: null },
        {
          id: 'stacks-h2',
          text: 'A cookbook is not poetry. The cabinet number is on its plate.',
          penaltyS: 60,
          releaseAfterS: 480,
        },
      ],
      unlockText: 'Behind the cabinet, a narrow stair leads down to the archive.',
    },
    {
      id: 'archive',
      title: 'The Archive',
      intro:
        'Dusty boxes and an iron door to the street, with a keypad and a riddle carved above it.',
      locks: [
        { id: 'archive-door', label: 'Iron door keypad', kind: 'code', answer: '1887' },
        { id: 'riddle', label: 'Answer the riddle', kind: 'phrase', answers: ['book', 'a book'] },
      ],
      clues: [
        {
          id: 'archive-stone',
          roleId: null,
          kind: 'text',
          body: 'A founding stone by the door: "Ashford Library, built 1887."',
        },
        {
          id: 'archive-riddle',
          roleId: null,
          kind: 'text',
          body: 'Carved above the door: "I have a spine but no bones, pages but no tree. You have been surrounded by me all night. What am I?"',
        },
      ],
      hints: [
        { id: 'archive-h1', text: 'The keypad wants a year.', penaltyS: 30, releaseAfterS: null },
        {
          id: 'archive-h2',
          text: 'What is this whole building full of?',
          penaltyS: 60,
          releaseAfterS: 480,
        },
      ],
      unlockText: 'The iron door groans open onto the cold night street.',
    },
  ],
  finale: 'You are out. Next time, check the closing hours.',
};
