import type { ComponentProps, ComponentType } from 'react';
import { useEscapeScreen } from '../game/escape/screen/use-escape-screen';
import { EscapeScreen } from './escape-screen-page';
import type { ScreenSurface } from './screen-page';

type QuizScreenProps = ComponentProps<typeof ScreenSurface>;

/**
 * The projection's seam (M6 §1.3): the escape big screen while the room runs an
 * escape game, else the quiz screen (`quiz`, upstream's `ScreenSurface`) with the
 * same props. Kept out of `screen-page.tsx` so its diff stays a few lines.
 */
export function EscapeOrQuiz({
  quiz: Quiz,
  attachSeq,
  ...props
}: QuizScreenProps & { quiz: ComponentType<QuizScreenProps>; attachSeq: number }) {
  const escape = useEscapeScreen(props.pin, {
    view: props.view,
    attachSeq,
    socket: props.socket,
  });
  if (!escape.active) return <Quiz {...props} />;
  return (
    <EscapeScreen
      pin={props.pin}
      view={props.view}
      escape={escape}
      role={props.role}
      sound={props.sound ?? true}
    />
  );
}
