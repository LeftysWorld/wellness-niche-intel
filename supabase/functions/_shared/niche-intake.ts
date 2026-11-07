// Rules a new niche must pass before it reaches the owner. Pure, so tested.

/** "camp-and-retreat-center" → "Camp and retreat center"; proper names are kept. */
export function displayName(raw: string): string {
  let s = raw.trim().replace(/^(example|design|niche)\s*:\s*/i, '');
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(s)) s = s.replace(/[-_]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return raw.trim();
  // Sentence case only when the whole name is lower case (keeps "Kneipp", "Nordic").
  return s === s.toLowerCase() ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A name that looks like an identifier rather than words. */
export function looksLikeSlug(name: string): boolean {
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(name.trim());
}

export interface IntakeProposal {
  name: string;
  needs_land_or_structure: boolean;
  solo_operable: boolean;
  est_startup_usd: { low: number; high: number };
  risk_tags: string[];
  /** Example businesses whose quotes were confirmed on their pages. */
  confirmedExamples: { url: string }[];
}

export interface IntakeProfile {
  capital_max: number;
  excluded_tags: string[];
}

/** Why a proposal fails intake; empty when it passes. */
export function intakeProblems(p: IntakeProposal, profile: IntakeProfile): string[] {
  const problems: string[] = [];
  if (!p.name.trim() || looksLikeSlug(p.name)) problems.push('Give it a plain-words name, not an identifier.');
  if (!p.needs_land_or_structure) problems.push('It must need land or a dedicated structure.');
  if (!p.solo_operable) problems.push('One owner must be able to run it with occasional help.');
  const hosts = new Set(p.confirmedExamples.map((e) => host(e.url)));
  if (hosts.size < 2) problems.push(`It needs at least two real operating examples on different websites with confirmed quotes (has ${hosts.size}).`);
  const low = Number(p.est_startup_usd?.low);
  if (!(low > 0)) problems.push('Give a realistic startup cost range.');
  // Leasing can bring the start well under a build budget, so allow up to twice the capital at the low end.
  else if (low > profile.capital_max * 2) problems.push(`Its cheapest realistic start ($${Math.round(low).toLocaleString('en-US')}) is far over the owner's $${profile.capital_max.toLocaleString('en-US')}.`);
  const banned = p.risk_tags.filter((t) => profile.excluded_tags.includes(t));
  if (banned.length) problems.push(`The owner excludes: ${banned.join(', ')}.`);
  return problems;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
