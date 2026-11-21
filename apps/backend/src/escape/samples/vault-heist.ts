import type { EscapeTemplateContent } from '@quiz-dock/contracts';

/** Roles mode: a hacker, a safecracker and a lookout rob a bank vault in four stages. */
export const vaultHeist: EscapeTemplateContent = {
  title: 'Vault Heist',
  intro:
    'The Grand Meridian Bank closes at six. Your crew has one hour inside before the night shift arrives. Each of you sees things the others cannot: talk.',
  difficulty: 'standard',
  targetMinutes: 40,
  mode: 'roles',
  roles: [
    { id: 'hacker', name: 'Hacker', description: 'Reads screens, notes and passwords.' },
    { id: 'safecracker', name: 'Safecracker', description: 'Reads dials, locks and metal.' },
    { id: 'lookout', name: 'Lookout', description: 'Watches the guards and the street.' },
  ],
  stages: [
    {
      id: 'lobby',
      title: 'The Lobby',
      intro: 'A staff door and a guard desk stand between you and the back offices.',
      locks: [
        { id: 'lobby-door', label: 'Staff door keypad', kind: 'code', answer: '0417' },
        {
          id: 'lobby-badge',
          label: 'Which badge gets you past the guard?',
          kind: 'choice',
          options: [
            { id: 'red', label: 'Red badge', image: null },
            { id: 'blue', label: 'Blue badge', image: null },
            { id: 'green', label: 'Green badge', image: null },
          ],
          correct: ['blue'],
        },
      ],
      clues: [
        {
          id: 'lobby-plaque',
          roleId: null,
          kind: 'text',
          body: 'A brass plaque: "Branch opened 17 April." Under it, a sticker: "Staff code = month and day, four digits, month first."',
        },
        {
          id: 'lobby-guard',
          roleId: 'lookout',
          kind: 'text',
          body: 'Through the glass you watch the guard wave through everyone wearing a blue badge and stop the rest.',
        },
      ],
      hints: [
        {
          id: 'lobby-h1',
          text: 'The plaque gives a date; the sticker tells you how to write it.',
          penaltyS: 30,
          releaseAfterS: null,
        },
        {
          id: 'lobby-h2',
          text: 'April is month 04. The Lookout knows the badge colour.',
          penaltyS: 60,
          releaseAfterS: 600,
        },
      ],
      unlockText: 'The staff door clicks open and the guard nods you through.',
    },
    {
      id: 'security',
      title: 'The Security Room',
      intro:
        'Monitors cover one wall. The camera master switch needs three keys turned at once, each with its own word.',
      locks: [
        {
          id: 'security-switch',
          label: 'Camera master switch',
          kind: 'combined',
          parts: [
            { roleId: 'hacker', answer: 'falcon' },
            { roleId: 'safecracker', answer: 'copper' },
            { roleId: 'lookout', answer: 'midnight' },
          ],
        },
        {
          id: 'security-override',
          label: 'Alarm override phrase',
          kind: 'phrase',
          answers: ['lights out'],
        },
      ],
      clues: [
        {
          id: 'security-shared',
          roleId: null,
          kind: 'text',
          body: 'The night guard\'s notebook, last page: "If the alarm trips, the override is LIGHTS OUT."',
        },
        {
          id: 'security-hacker',
          roleId: 'hacker',
          kind: 'text',
          body: 'A sticky note on the first monitor: "Key 1 word: FALCON".',
        },
        {
          id: 'security-safecracker',
          roleId: 'safecracker',
          kind: 'text',
          body: 'The second key is stamped with its word in tiny letters: COPPER.',
        },
        {
          id: 'security-lookout',
          roleId: 'lookout',
          kind: 'text',
          body: 'The shift rota on the wall says the third key word changes daily. Today it is MIDNIGHT.',
        },
      ],
      hints: [
        {
          id: 'security-h1',
          text: 'Each role has one key word for the master switch. Each of you enters your own.',
          penaltyS: 30,
          releaseAfterS: null,
        },
        {
          id: 'security-h2',
          text: 'The override phrase is in the notebook everyone can read.',
          penaltyS: 60,
          releaseAfterS: 600,
        },
      ],
      unlockText: 'The monitors go black. Nobody is watching now.',
    },
    {
      id: 'vault-door',
      title: 'The Vault Door',
      intro: 'A round steel door with three medal dials and a numeric keypad.',
      locks: [
        {
          id: 'vault-dials',
          label: 'Turn the medal dials in order',
          kind: 'sequence',
          items: [
            { id: 'bronze', label: 'Bronze dial' },
            { id: 'gold', label: 'Gold dial' },
            { id: 'silver', label: 'Silver dial' },
          ],
          order: ['gold', 'silver', 'bronze'],
        },
        { id: 'vault-keypad', label: 'Vault keypad', kind: 'code', answer: '314' },
      ],
      clues: [
        {
          id: 'vault-medals',
          roleId: null,
          kind: 'text',
          body: 'Engraved above the dials: "Turn them as the medals are won: first place, then second, then third."',
        },
        {
          id: 'vault-scratch',
          roleId: 'safecracker',
          kind: 'text',
          body: 'Scratched inside the keypad cover: "Three digits. Think of a circle: the first three of pi."',
        },
      ],
      hints: [
        {
          id: 'vault-h1',
          text: 'Gold is first place.',
          penaltyS: 30,
          releaseAfterS: null,
        },
        {
          id: 'vault-h2',
          text: 'Pi starts 3.14...',
          penaltyS: 60,
          releaseAfterS: 600,
        },
      ],
      unlockText: 'Bolts slide back one by one. The vault swings open.',
    },
    {
      id: 'getaway',
      title: 'The Getaway',
      intro:
        'Bags full. The van waits outside, but it only starts with a spoken word, and two of the four exits are guarded.',
      locks: [
        {
          id: 'getaway-van',
          label: 'Voice lock on the van',
          kind: 'phrase',
          answers: ['open sesame'],
        },
        {
          id: 'getaway-exits',
          label: 'Which exits are unguarded? Pick all.',
          kind: 'choice',
          options: [
            { id: 'north', label: 'North exit', image: null },
            { id: 'south', label: 'South exit', image: null },
            { id: 'east', label: 'East exit', image: null },
            { id: 'west', label: 'West exit', image: null },
          ],
          correct: ['south', 'west'],
        },
      ],
      clues: [
        {
          id: 'getaway-note',
          roleId: null,
          kind: 'text',
          body: 'A note taped inside the vault: "The van answers only to OPEN SESAME."',
        },
        {
          id: 'getaway-radio',
          roleId: 'lookout',
          kind: 'text',
          body: 'Your radio crackles: "Guards posted at the north and east exits. The others are clear."',
        },
        {
          id: 'getaway-screen',
          roleId: 'hacker',
          kind: 'text',
          body: 'The door panel shows four exits. Two are marked "occupied", but the screen does not say which.',
        },
      ],
      hints: [
        {
          id: 'getaway-h1',
          text: 'The Lookout heard where the guards are. Pick the other two.',
          penaltyS: 30,
          releaseAfterS: null,
        },
        {
          id: 'getaway-h2',
          text: 'The van phrase is an old story about a cave of treasure.',
          penaltyS: 60,
          releaseAfterS: 600,
        },
      ],
      unlockText: 'The engine roars. You slip out the side as the night shift walks in the front.',
    },
  ],
  finale: 'Clean getaway. The Grand Meridian will not notice until morning.',
};
