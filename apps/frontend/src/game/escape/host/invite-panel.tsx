import { Share2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { JoinAddressPicker } from '../../join-address-picker';
import { joinBase, joinHostLabel, joinUrlFor } from '../../join-url';
import type { GameView } from '../../use-game-session';

/**
 * The link alone, never a picture of the QR code: it opens in one tap wherever it
 * lands, its PIN in it. The share sheet, else the clipboard, else the address to
 * copy by hand (plain http on a local network has neither). As the quiz console.
 */
async function shareLink(
  url: string,
  note: (text: string | null) => void,
  t: (key: string, o?: Record<string, string>) => string,
): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ url });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      note(t('control.shareCopied'));
    } else {
      note(t('control.shareByHand', { url }));
    }
  } catch {
    // Share sheet closed, or refused: nothing to say.
  }
}

/** The lobby's invitation: the PIN in large digits, its QR and link, and where they point. */
export function InvitePanel({
  pin,
  view,
  onJoinUrl,
}: {
  pin: string;
  view: Pick<GameView, 'joinBaseUrl'>;
  /** The host picked another address for the QR and the link (`host:join-url`). */
  onJoinUrl: (baseUrl: string) => void;
}) {
  const { t } = useTranslation(['escape', 'live']);
  const [note, setNote] = useState<string | null>(null);
  const url = joinUrlFor(view, pin);
  const live = (key: string, o?: Record<string, string>) => t(`live:${key}`, o);
  return (
    <section aria-labelledby="escape-invite" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="escape-invite" className="text-lg font-semibold">
        {t('host.invite.title')}
      </h2>
      <div className="flex flex-wrap items-center gap-4">
        <div className="rounded-md border bg-white p-2">
          <QRCodeSVG value={url} size={148} aria-label={t('live:control.qrLabel')} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground text-sm">{t('host.invite.goTo')}</span>
          <span className="font-semibold break-all">{joinHostLabel(view)}</span>
          <span
            role="img"
            className="font-mono text-4xl font-bold tracking-[0.2em] md:text-5xl"
            aria-label={t('host.invite.pinLabel', { digits: pin.split('').join(' ') })}
          >
            {pin}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            onClick={() => void shareLink(url, setNote, live)}
          >
            <Share2 className="size-4" aria-hidden />
            {t('live:control.share')}
          </Button>
        </div>
      </div>
      <p className="text-sm break-all">
        <a href={url} className="underline">
          {url}
        </a>
      </p>
      {note ? (
        <p role="status" className="text-muted-foreground text-sm">
          {note}
        </p>
      ) : null}
      {/* A console opened on localhost must not invite to localhost. */}
      <JoinAddressPicker current={joinBase(view)} onChange={onJoinUrl} room={pin} />
    </section>
  );
}
