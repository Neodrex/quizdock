import { useEffect, useState } from 'react';
import { serverNow } from '../../clock';

/** One server-time tick for the whole console (§1.7): not one interval per team. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
