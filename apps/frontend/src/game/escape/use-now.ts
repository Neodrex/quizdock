import { useEffect, useState } from 'react';
import { serverNow } from '../clock';

/** One server-time tick for a whole console or big screen (M5 §1.7, M6 Task 6.14): not one interval per team. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
