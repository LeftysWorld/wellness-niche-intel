// Automated confirmation of a scouted value: several independent sources, each
// quote checked against its page, outliers dropped, the median taken, and
// confidence set by how many separate sources agree. No I/O, so it is tested.

export interface Observation {
  value: number;
  url: string;
  /** The quoted figure was found on the page or in the search result text. */
  confirmed: boolean;
  /** For totals made of parts: which part (e.g. a town) this figure is. */
  part?: string;
}

export interface Consensus {
  value: number;
  low: number;
  high: number;
  /** Distinct source sites (by host) behind the kept observations. */
  sources: number;
  confidence: 'high' | 'medium' | 'low';
  kept: Observation[];
  dropped: Observation[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Combine observations into one value. Confirmed observations are preferred;
 * unconfirmed ones are used only when nothing was confirmed (and then the
 * result is low confidence). Values more than 3x away from the median are
 * dropped as outliers (a sale price read as a rent, a typo, another currency).
 */
export function consensus(observations: Observation[]): Consensus | null {
  const positive = observations.filter((o) => Number.isFinite(o.value) && o.value > 0);
  if (!positive.length) return null;
  const confirmed = positive.filter((o) => o.confirmed);
  const pool = confirmed.length ? confirmed : positive;
  const mid = median(pool.map((o) => o.value));
  const kept = pool.filter((o) => o.value >= mid / 3 && o.value <= mid * 3);
  const dropped = positive.filter((o) => !kept.includes(o));
  const values = kept.map((o) => o.value);
  const value = median(values);
  const sources = new Set(kept.map((o) => host(o.url))).size;
  const low = values.length > 1 ? quantile(values, 0.25) : value;
  const high = values.length > 1 ? quantile(values, 0.75) : value;
  // Agreement across separate sites is the automated stand-in for a human check.
  const spreadOk = high <= low * 2;
  const confidence: Consensus['confidence'] = !confirmed.length
    ? 'low'
    : sources >= 3 && spreadOk
      ? 'high'
      : sources >= 2
        ? 'medium'
        : 'low';
  return { value, low: Math.min(low, value), high: Math.max(high, value), sources, confidence, kept, dropped };
}
