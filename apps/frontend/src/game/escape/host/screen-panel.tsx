import type { RoomSoundsPayload, ThemeValues } from '@quiz-dock/contracts';
import { EllipsisVertical, ExternalLink, Eye, Share2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import type { GameSocket } from '../../game-client';
import { RoomSoundsButton } from '../../game-sounds-panel';

/**
 * The console's big screen controls (M6 Task 6.15): open the projection in a new tab,
 * pair a screen on another computer by the code it shows (upstream's `host:pair-screen`
 * and its `live:control.*` texts, as the quiz console's), and the room's sound controls
 * (upstream's `RoomSoundsButton`, `host:sounds`). Off while the connection is down.
 */
export function ScreenPanel({
  pin,
  socket,
  sounds,
  theme,
  disabled,
}: {
  pin: string;
  socket: GameSocket | null;
  sounds: RoomSoundsPayload | null;
  theme: ThemeValues | null;
  disabled: boolean;
}) {
  const { t } = useTranslation('live');
  const [pairCode, setPairCode] = useState('');
  const [pairResult, setPairResult] = useState<'paired' | 'failed' | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const screenUrl = `${window.location.origin}/session/${pin}/projection`;

  const openScreen = () => window.open(screenUrl, '_blank', 'noopener,noreferrer');
  const pairScreen = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !/^\d{4}$/.test(pairCode)) return;
    socket?.emit('host:pair-screen', { pin, code: pairCode }, (res: { ok: boolean }) => {
      setPairResult(res.ok ? 'paired' : 'failed');
      if (res.ok) setPairCode('');
    });
  };
  // The link alone, as the quiz console sends it: it opens in one tap wherever it lands.
  const shareLink = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ url: screenUrl });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(screenUrl);
        setShareNote(t('control.shareCopied'));
      } else {
        setShareNote(t('control.shareByHand', { url: screenUrl }));
      }
    } catch {
      /* share cancelled or not supported */
    }
  };

  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Tooltip label={t('control.screenButtonTooltip')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={openScreen}
          >
            <Eye className="size-4" aria-hidden />
            {t('control.screenButton')}
            {/* It opens in a new tab: said before the click. */}
            <ExternalLink className="text-muted-foreground size-3.5" aria-hidden />
          </Button>
        </Tooltip>
        {/* Portaled, so the fieldset does not reach it: a drop closes it (a new key). */}
        <Popover
          key={disabled ? 'off' : 'on'}
          align="end"
          className="w-80"
          trigger={({ toggle, open }) => (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={disabled}
              onClick={() => {
                setPairResult(null);
                setShareNote(null);
                toggle();
              }}
              aria-expanded={open}
              aria-label={t('control.screenElsewhere')}
            >
              <EllipsisVertical className="size-4" aria-hidden />
            </Button>
          )}
        >
          <form className="flex flex-col gap-3" onSubmit={pairScreen} noValidate>
            <span className="font-semibold">{t('control.screenElsewhere')}</span>
            <p className="text-muted-foreground text-sm">{t('control.screenElsewhereHint')}</p>
            <div className="self-center rounded-md border bg-white p-2">
              <QRCodeSVG value={screenUrl} size={120} aria-label={t('control.screenElsewhere')} />
            </div>
            <span className="font-mono text-xs break-all select-all">{screenUrl}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void shareLink()}
            >
              <Share2 className="size-4" aria-hidden />
              {t('control.share')}
            </Button>
            {shareNote ? <p className="text-muted-foreground text-xs">{shareNote}</p> : null}
            <Label htmlFor="escape-pair-code">{t('control.pairCodeLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id="escape-pair-code"
                value={pairCode}
                onChange={(e) => {
                  setPairCode(e.target.value.replace(/\D/g, '').slice(0, 4));
                  setPairResult(null);
                }}
                inputMode="numeric"
                autoComplete="off"
                className="w-24 font-mono tracking-[0.3em]"
                aria-describedby="escape-pair-result"
              />
              <Button type="submit" variant="outline" size="sm" disabled={pairCode.length !== 4}>
                {t('control.pairButton')}
              </Button>
            </div>
            <p id="escape-pair-result" role="status" className="text-sm">
              {pairResult === 'paired' ? t('control.paired') : null}
              {pairResult === 'failed' ? (
                <span className="text-destructive">{t('control.pairFailed')}</span>
              ) : null}
            </p>
          </form>
        </Popover>
      </div>
      {/* Its dialog is portaled too: a drop closes it the same way. */}
      <RoomSoundsButton
        key={disabled ? 'off' : 'on'}
        sounds={sounds}
        theme={theme}
        onChange={(patch) => socket?.emit('host:sounds', { pin, ...patch })}
      />
    </fieldset>
  );
}
