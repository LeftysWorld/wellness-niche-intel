// What a recorded price buys, and the check that it matches the offer being
// modelled. Pure (no I/O) so it is tested.

/** What a price buys. A price is only comparable when these match the offer being modelled. */
export interface PriceTerms {
  product: string;
  unit: string;
  party_size?: number;
  duration_minutes?: number;
  /** When the page showed it (YYYY-MM-DD, or "undated"). */
  seen: string;
}

/** Why a price's terms cannot be accepted, or null. Pure, so it is tested. */
export function termsProblem(terms: Partial<PriceTerms> | undefined, want: { unit?: string; units: readonly string[] }): string | null {
  if (!terms || !terms.product?.trim()) return 'Prices need terms: the product name as the page shows it, the unit, party size and length where the page gives them, and when it was seen.';
  if (!terms.unit || !want.units.includes(terms.unit)) return `terms.unit must be one of: ${want.units.join(', ')}.`;
  if (want.unit && terms.unit !== want.unit) {
    return `This offer is priced ${want.unit.replace('_', ' ')} in the model, but that price is ${terms.unit.replace('_', ' ')}. Find a ${want.unit.replace('_', ' ')} price, or convert it and say how in note (e.g. a $200 room for up to 4 is not a $200 per-person price).`;
  }
  if (!terms.seen?.trim()) return 'terms.seen: the date the page shows for the price, or "undated".';
  return null;
}

