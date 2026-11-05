import type { BusinessModel } from './types.ts';
import type { Scenario, SimulationPath } from './simulate.ts';
import { loanBalance } from './simulate.ts';

export interface ValuationPoint {
  year: number;
  price: number;
  netProceeds: number;
  method: 'sde' | 'ebitda' | 'asset';
  propertyValue: number;
}

/**
 * Selling price at the end of an operating year = business value + property.
 *
 * The business is valued on its earnings as a buyer would see them: owner
 * earnings (SDE) times a multiple, or EBITDA after a market-rate manager times
 * a multiple, whichever is higher. When the owner also owns the site, the
 * business is charged a market rent first and the land and buildings are added
 * separately, so the property is neither ignored nor counted twice.
 */
export function valueAtYear(model: BusinessModel, sc: Scenario, path: SimulationPath, year: number): ValuationPoint {
  const from = (year - 1) * 12;
  const to = Math.min(year * 12, path.operatingProfit.length);
  let earnings = 0;
  for (let i = from; i < to; i++) earnings += path.operatingProfit[i];
  const ex = model.exit;
  const rent = ex.ownsProperty ? (ex.marketRentMonthly ?? 0) * 12 : 0;
  const sde = earnings - rent;
  const sdePrice = Math.max(0, sde) * sc.sdeMultiple * (1 - ex.ownerDependenceDiscount) * (1 - ex.countryDiscount);
  const ebitda = sde - sc.managerMonthlyCost * 12;
  const ebitdaPrice = Math.max(0, ebitda) * sc.ebitdaMultiple * (1 - ex.countryDiscount);

  let propertyValue = 0;
  if (ex.ownsProperty) {
    const yearsHeld = year + path.preOpeningMonths / 12;
    const land = ex.landValue * Math.pow(1 + sc.landAppreciation, yearsHeld);
    const building = ex.buildingValue * Math.max(0, 1 - yearsHeld / Math.max(1, ex.buildingLifeYears));
    propertyValue = (land + building) * (1 - ex.countryDiscount);
  }
  const business = Math.max(sdePrice, ebitdaPrice);
  const method: ValuationPoint['method'] = business <= 0 ? 'asset' : ebitdaPrice > sdePrice ? 'ebitda' : 'sde';
  const price = business + propertyValue;

  const f = path.funding;
  const debt = loanBalance(f.loan, f.ratePct, f.termMonths, year * 12);
  return { year, price, netProceeds: price * (1 - ex.sellingCostPct) - debt, method, propertyValue };
}
