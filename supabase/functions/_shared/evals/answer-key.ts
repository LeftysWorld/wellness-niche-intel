// The answer key: local values checked by hand against official or primary
// sources, each with an accepted range. The scout is graded on whether what
// it finds (and what the ledger holds) falls inside the range.
//
// Ranges are deliberately honest about definitions: "fully loaded" wages add
// the employer's legal charges to the official minimum; lodging taxes are
// what a small, registered lodging business remits on gross revenue (VAT
// net of input credits is lower than the headline rate, hence the ranges).
// Add entries as you verify more values; aim for 50 across the four countries.

export interface AnswerKeyEntry {
  id: string;
  /** Location slug in the database. */
  location: string;
  key: string;
  /** Accepted range, in the value's own unit. Local-currency ranges are converted with the current exchange rate. */
  range: [number, number];
  currency?: 'USD' | 'COP' | 'CRC';
  checked: string;
  sources: string[];
  note: string;
}

export const ANSWER_KEY: AnswerKeyEntry[] = [
  {
    id: 'co-wage-2026',
    location: 'co',
    key: 'labor.monthly_wage_usd',
    // SMMLV 1,750,905 + transport aid 249,095 = 2,000,000; employer pension (12%), ARL, family fund (4%),
    // prima, cesantías, interest and holidays add roughly 35-42% of salary (health and SENA/ICBF are exempt below 10 SMMLV).
    range: [2_500_000, 3_000_000],
    currency: 'COP',
    checked: '2026-11-07',
    sources: [
      'https://consultorsalud.com/aumento-del-salario-minimo-en-colombia-2026/',
      'https://www.siigo.com/blog/derecho-laboral/salario-minimo-vigente/',
    ],
    note: 'Decretos 1469 and 1470 of 2025: minimum wage COP 1,750,905 plus COP 249,095 transport aid. Fully loaded for an entry-level hospitality worker.',
  },
  {
    id: 'cr-wage-2026',
    location: 'cr',
    key: 'labor.monthly_wage_usd',
    // Unskilled generic worker ₡373,092 a month (Decreto 45303-MTSS) plus about 26.7% employer charges ≈ ₡473,000;
    // hospitality roles often pay somewhat above the floor.
    range: [470_000, 650_000],
    currency: 'CRC',
    checked: '2026-11-07',
    sources: ['https://wageindicator.org/es-cr/ai/trabajo-en-costa-rica/salario-minimo/', 'https://blog.alegra.com/costa-rica/salario-minimo-costa-rica/'],
    note: 'Minimum for an unskilled generic worker plus employer social charges (CCSS and others, about 26.7%).',
  },
  {
    id: 'sv-wage-2026',
    location: 'sv',
    key: 'labor.monthly_wage_usd',
    // $408.80 (commerce and services) plus ISSS 7.5%, AFP 8.75%, INSAFORP 1% and accrued aguinaldo and vacation.
    range: [480, 650],
    currency: 'USD',
    checked: '2026-11-07',
    sources: ['https://www.ey.com/es_ce/technical/tax/tax-alerts/el-salvador-salario-minimo-2026', 'https://finiquitojusto.com/?p=4005'],
    note: 'Commerce and services minimum $408.80 a month (Decreto 11, May 2025, unchanged in 2026) plus employer charges.',
  },
  {
    id: 'cr-lodging-tax',
    location: 'cr',
    key: 'tax.revenue_pct',
    range: [0.08, 0.135],
    checked: '2026-11-07',
    sources: ['https://siemprealdia.co/costa-rica/impuestos/impuesto-sobre-el-valor-agregado-iva/', 'https://www.larepublica.net/noticia/ministro-de-turismo-hacienda-nos-explica-que-la-situacion-fiscal-no-permite-una-prorroga-adicional-al-iva'],
    note: 'Lodging pays the full 13% IVA (since 1982 for lodging; all ICT-registered tourism services since July 2023). Net of input credits, a small operator remits roughly 8-13% of gross.',
  },
  {
    id: 'sv-lodging-tax',
    location: 'sv',
    key: 'tax.revenue_pct',
    range: [0.1, 0.185],
    checked: '2026-11-07',
    sources: ['https://taxratesbycountry.com/es/vat-rate-el-salvador/', 'https://esim.holafly.com/es/blog/impuestos/impuestos-el-salvador/'],
    note: '13% IVA plus the 5% special tourism contribution on lodging; net of IVA input credits roughly 10-18% of gross.',
  },
  {
    id: 'madison-land',
    location: 'us-nc-madison',
    key: 'land.price_per_acre_usd',
    range: [12_000, 45_000],
    currency: 'USD',
    checked: '2026-11-07',
    sources: ['https://land.com/Madison-County-NC/all-land/', 'https://www.homes.com/madison-county-nc/land-for-sale'],
    note: 'Median asking price across all listings is about $12,300/acre (mostly 50+ acre tracts); 1-10 acre parcels list at roughly $10,000-$60,000/acre.',
  },
];

/** Accepted range in the value's unit (USD for money keys). */
export function rangeUsd(e: AnswerKeyEntry, fx: { cop_per_usd?: number; crc_per_usd?: number }): [number, number] | null {
  if (!e.currency || e.currency === 'USD') return e.range;
  const rate = e.currency === 'COP' ? fx.cop_per_usd : fx.crc_per_usd;
  if (!rate || rate <= 0) return null;
  return [Math.round(e.range[0] / rate), Math.round(e.range[1] / rate)];
}
