// Rules that govern a business in a place: who issues the permits, what the
// health and zoning rules require. Recorded only from official pages, with an
// exact quote, so names and requirements are never written from memory.
// Pure helpers (no I/O) so they are tested.

export const RULE_TOPICS = ['permit', 'health', 'zoning', 'building', 'license', 'tax', 'labor'] as const;
export type RuleTopic = (typeof RULE_TOPICS)[number];

export interface RuleRecord {
  topic: RuleTopic;
  /** The authority as its own page names it, e.g. "South Carolina Department of Environmental Services". */
  agency: string;
  /** One plain sentence: what is required. */
  requirement: string;
  url: string;
  quote: string;
}

/**
 * Official sources: government domains in the US and abroad (.gov, .gov.xx,
 * .gob.xx, .go.xx, .gouv.xx, .mil), US state and city domains (.us) and
 * legislature or code hosts that publish the law itself.
 */
export function isOfficialHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (/(^|\.)(gov|mil)$/.test(h)) return true;
  if (/\.(gov|gob|go|gouv|govt|gc)\.[a-z]{2}$/.test(h)) return true;
  if (/\.(state|co|ci|city|county)\.[a-z]{2}\.us$/.test(h) || /\.[a-z]{2}\.us$/.test(h)) return true;
  if (/^((cityof|townof|villageof|countyof)[a-z-]+|[a-z-]+(county|parish|township))\.(org|com|net)$/.test(h)) return true;
  return ['municode.com', 'library.municode.com', 'codelibrary.amlegal.com', 'law.cornell.edu', 'ecode360.com', 'pgcode.com', 'scstatehouse.gov'].includes(h);
}

/** Why the analyst may not finish yet on rules: a niche with permit needs must have at least one sourced rule. */
export function rulesGap(needsPermits: boolean, rules: RuleRecord[]): string | null {
  if (!needsPermits) return null;
  if (!rules.some((r) => r.topic === 'permit' || r.topic === 'health' || r.topic === 'zoning')) {
    return 'Record who permits this business here and what they require, from an official page, with record_rule (at least the permit or health authority).';
  }
  return null;
}
