import type { BusinessModel } from '../supabase/functions/_shared/engine/index.ts';
import { point, tri } from '../supabase/functions/_shared/engine/index.ts';

/**
 * Colombia, leased finca near Llanogrande, 4 dark rooms — the hand-built
 * model from the original research. With every input at its mode, mature
 * monthly profit should be about $2,776 (revenue $11,400, costs $8,624).
 */
export function colombiaLeasedFinca(): BusinessModel {
  return {
    label: 'Dark retreat · leased finca · Llanogrande',
    startupCosts: [
      { key: 'fit_out', label: 'Room conversion, sauna, plunge', amount: tri(36000, 42000, 52000) },
      { key: 'deposit', label: 'Lease deposit', amount: point(6400) },
    ],
    contingencyPct: tri(0.1, 0.15, 0.25),
    workingCapitalMonths: 6,
    financing: { kind: 'cash', ownerCash: 150000 },
    streams: [
      {
        key: 'dark_nights',
        label: 'Dark-room nights',
        units: 4,
        sellablePerUnitPerMonth: 25,
        price: tri(150, 180, 210),
        startOccupancy: tri(0.2, 0.3, 0.35),
        matureOccupancy: tri(0.4, 0.55, 0.65),
        monthsToMature: tri(24, 30, 42),
        ownerHoursPerSale: 1.5,
      },
      {
        key: 'sessions',
        label: 'Short sessions and day passes',
        units: 1,
        sellablePerUnitPerMonth: 1,
        price: tri(1000, 1500, 2000),
        startOccupancy: point(0.4),
        matureOccupancy: point(1),
        monthsToMature: tri(24, 30, 36),
      },
    ],
    costs: {
      fixed: [
        { key: 'lease', label: 'Finca lease', amount: tri(2900, 3195, 3800) },
        { key: 'utilities', label: 'Utilities', amount: tri(300, 400, 550) },
        { key: 'admin', label: 'Insurance, accounting, software', amount: tri(250, 300, 400) },
        { key: 'fit_out_amortization', label: 'Fit-out amortization (36 months)', amount: point(42000 / 36) },
      ],
      staffing: [
        { key: 'helper', label: 'Part-time helper', amount: tri(400, 450, 550) },
        { key: 'helper', label: 'Full-time helper', amount: tri(780, 850, 950), fromMonth: 13 },
      ],
      variablePctOfRevenue: tri(0.15, 0.18, 0.22),
      perSaleCost: { dark_nights: tri(10, 12, 15) },
      revenueTaxPct: point(0),
    },
    exit: {
      sdeMultiple: tri(1.5, 2.2, 3),
      ebitdaMultiple: tri(3, 4, 5),
      managerMonthlyCost: tri(1200, 1500, 2000),
      ownsProperty: false,
      landValue: 0,
      buildingValue: 0,
      landAppreciation: point(0),
      buildingLifeYears: 30,
      sellingCostPct: 0.1,
      ownerDependenceDiscount: 0.2,
      countryDiscount: 0.15,
    },
    capacity: { ownerHoursPerMonth: 220, ownerFixedHoursPerMonth: 60 },
  };
}

/** Western NC, owned, financed: checks the loan path and the asset valuation path. */
export function westernNcFinanced(): BusinessModel {
  return {
    label: 'Dark retreat · owned · western NC',
    startupCosts: [
      { key: 'land', label: 'Land (about 5 acres)', amount: tri(70000, 90000, 120000) },
      { key: 'site', label: 'Site work: access, well, septic, power', amount: tri(50000, 65000, 90000) },
      { key: 'rooms', label: '3 dark rooms in one building', amount: tri(150000, 180000, 220000) },
      { key: 'recovery', label: 'Sauna and cold plunge', amount: tri(20000, 25000, 35000) },
    ],
    contingencyPct: tri(0.1, 0.15, 0.25),
    workingCapitalMonths: 6,
    financing: { kind: 'loan', ownerCash: 150000, minEquityPct: 0.2, ratePct: 8.5, termYears: 25 },
    streams: [
      {
        key: 'dark_nights',
        label: 'Dark-room nights',
        units: 3,
        sellablePerUnitPerMonth: 25,
        price: tri(240, 275, 320),
        startOccupancy: tri(0.2, 0.3, 0.35),
        matureOccupancy: tri(0.45, 0.55, 0.62),
        monthsToMature: tri(24, 30, 42),
        ownerHoursPerSale: 1.5,
      },
    ],
    costs: {
      fixed: [
        { key: 'tax_insurance', label: 'Property tax and insurance', amount: tri(1000, 1200, 1500) },
        { key: 'utilities', label: 'Utilities', amount: tri(550, 700, 900) },
        { key: 'admin', label: 'Accounting and software', amount: point(250) },
      ],
      staffing: [{ key: 'backup', label: 'Backup help', amount: tri(400, 500, 700) }],
      variablePctOfRevenue: tri(0.15, 0.18, 0.22),
      perSaleCost: { dark_nights: tri(25, 30, 36) },
      revenueTaxPct: point(0),
    },
    exit: {
      sdeMultiple: tri(2, 2.5, 3.2),
      ebitdaMultiple: tri(3.5, 4.5, 5.5),
      managerMonthlyCost: tri(3500, 4200, 5000),
      ownsProperty: true,
      landValue: 90000,
      buildingValue: 270000,
      landAppreciation: tri(0.01, 0.03, 0.05),
      buildingLifeYears: 30,
      sellingCostPct: 0.08,
      ownerDependenceDiscount: 0.15,
      countryDiscount: 0,
    },
    capacity: { ownerHoursPerMonth: 220, ownerFixedHoursPerMonth: 60 },
  };
}
