import type { BusinessModel } from './types.ts';
import type { Scenario, SimulationPath } from './simulate.ts';
import { loanBalance } from './simulate.ts';

export interface ValuationPoint {
  year: number;
  price: number;
  netProceeds: number;
  method: 'sde' | 'ebitda' | 'asset';
}

/**
 * Selling price at the end of a given year using three methods side by side:
 * owner earnings (SDE) multiple, EBITDA multiple after a market-rate manager,
 * and asset value for owned land and buildings. The highest defensible value
 * wins, because a seller would not accept less than the best of them.
 */
export function valueAtYear(model: BusinessModel, sc: Scenario, path: SimulationPath, year: number): ValuationPoint {
  const from = (year - 1) * 12;
  const to = Math.min(year * 12, path.profit.length);
  let sde = 0;
  for (let i = from; i < to; i++) sde += path.profit[i] + path.debtService[i];
  const ex = model.exit;
  const sdePrice = Math.max(0, sde) * sc.sdeMultiple * (1 - ex.ownerDependenceDiscount) * (1 - ex.countryDiscount);
  const ebitda = sde - sc.managerMonthlyCost * 12;
  const ebitdaPrice = Math.max(0, ebitda) * sc.ebitdaMultiple * (1 - ex.countryDiscount);
  let assetPrice = 0;
  if (ex.ownsProperty) {
    const land = ex.landValue * Math.pow(1 + sc.landAppreciation, year);
    const building = ex.buildingValue * Math.max(0, 1 - year / Math.max(1, ex.buildingLifeYears));
    assetPrice = (land + building) * (1 - ex.countryDiscount);
  }
  let price = sdePrice;
  let method: ValuationPoint['method'] = 'sde';
  if (ebitdaPrice > price) {
    price = ebitdaPrice;
    method = 'ebitda';
  }
  if (assetPrice > price) {
    price = assetPrice;
    method = 'asset';
  }
  const f = path.funding;
  const debt = loanBalance(f.loan, f.ratePct, f.termMonths, year * 12);
  return { year, price, netProceeds: price * (1 - ex.sellingCostPct) - debt, method };
}
