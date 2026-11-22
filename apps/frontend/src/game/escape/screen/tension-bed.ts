import { busInput, getMixer } from '../../media/audio-mixer';

/**
 * The tension music of the final minutes when the room has no track (M6 §1.9): a
 * synthesised pulse, so there is no audio asset to license. A low sine whose loudness
 * an LFO pulses, through a low-pass, on the MUSIC bus (so the room's music level and
 * mute apply). The pulse quickens in the last minute.
 */
export const BED_HZ = 55;
export const PULSE_HZ = 2;
export const URGENT_PULSE_HZ = 2.5;
const LOWPASS_HZ = 180;
const LEVEL = 0.35;

export interface TensionBed {
  setUrgent: (urgent: boolean) => void;
  /** Fades out over `fadeOutS` and stops; a second call does nothing. */
  stop: (fadeOutS: number) => void;
}

const silent: TensionBed = { setUrgent: () => undefined, stop: () => undefined };

export function startTensionBed({ fadeInS }: { fadeInS: number }): TensionBed {
  const mixer = getMixer();
  const into = busInput('music');
  if (!mixer || !into) return silent;
  const { ctx } = mixer;
  const now = ctx.currentTime;

  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = BED_HZ;
  // The pulse: the tone's gain swings around half its level.
  const pulse = ctx.createGain();
  pulse.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = PULSE_HZ;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(pulse.gain);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = LOWPASS_HZ;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, now);
  out.gain.linearRampToValueAtTime(1, now + fadeInS);
  const level = ctx.createGain();
  level.gain.value = LEVEL;
  tone.connect(pulse).connect(lowpass).connect(out).connect(level).connect(into);
  tone.start(now);
  lfo.start(now);
  // Stopped and faded out: the graph is let go of, not left hanging on the bus.
  const nodes: AudioNode[] = [tone, lfo, depth, pulse, lowpass, out, level];
  tone.onended = () => nodes.forEach((n) => n.disconnect());

  let stopped = false;
  return {
    setUrgent(urgent) {
      if (stopped) return;
      lfo.frequency.setTargetAtTime(urgent ? URGENT_PULSE_HZ : PULSE_HZ, ctx.currentTime, 0.5);
    },
    stop(fadeOutS) {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + fadeOutS);
      tone.stop(t + fadeOutS + 0.05);
      lfo.stop(t + fadeOutS + 0.05);
    },
  };
}
