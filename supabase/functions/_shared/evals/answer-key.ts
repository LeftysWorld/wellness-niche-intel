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
  /** For a value researched for one idea (a comparable price): the niche slug. The pairing's own value is graded. */
  niche?: string;
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
  {
    id: 'us-sc-upstate-land-2026',
    location: 'us-sc-upstate',
    key: 'land.price_per_acre_usd',
    // Active listings around Travelers Rest, Nov 2026: 11.4 ac at $19,737/ac, 14.2 ac at $24,246/ac,
    // 10.53 ac at $35,613/ac, 7.77 ac at $37,967/ac, 54.7 ac at $49,360/ac, 6 ac at $83,333/ac.
    range: [19_000, 85_000],
    checked: '2026-11-10',
    sources: [
      'https://landsearch.com/properties/100-chestnut-mountain-rd-travelers-rest-sc-29690/3881993',
      'https://www.landsearch.com/properties/504-chinquapin-rd-travelers-rest-sc-29690/4974220',
      'https://www.landsearch.com/properties/31-drake-rd-travelers-rest-sc-29690/5435958',
      'https://www.landsearch.com/properties/200-chestnut-mountain-rd-travelers-rest-sc/5161586',
    ],
    note: 'Asking prices for 5-55 acre tracts within about 20 minutes of Travelers Rest. Small lots near town run higher per acre.',
  },
  {
    id: 'nature-bathhouse-us-sc-upstate-private',
    location: 'us-sc-upstate',
    niche: 'nature-bathhouse',
    key: 'price.private_sessions_usd',
    // Per booking, not per person: Sauna House Greenville Sauna Cabana up to 4 people $200 (2 hours);
    // Drip Sauna (Asheville) private session for 1-6 guests from $188 per party.
    range: [185, 230],
    checked: '2026-11-10',
    sources: ['https://www.saunahouse.com/pages/team-wellness', 'https://letsbatch.com/experiences/a3d88aa1-5411-4708-8075-7871b81dabb9'],
    note: 'Private sauna room for a small group, per booking.',
  },
  {
    id: 'nature-bathhouse-us-sc-upstate-daypass',
    location: 'us-sc-upstate',
    niche: 'nature-bathhouse',
    key: 'price.day_passes_usd',
    // Drip Sauna community session $30/person (as of Dec 2025); US median drop-in about $35.
    range: [25, 40],
    checked: '2026-11-10',
    sources: ['https://boilingbones.blogspot.com/2025/12/drip-nordic-sauna-north-carolina.html'],
    note: 'Community sauna session per person.',
  },
];

/** Accepted range in the value's unit (USD for money keys). */
export function rangeUsd(e: AnswerKeyEntry, fx: { cop_per_usd?: number; crc_per_usd?: number }): [number, number] | null {
  if (!e.currency || e.currency === 'USD') return e.range;
  const rate = e.currency === 'COP' ? fx.cop_per_usd : fx.crc_per_usd;
  if (!rate || rate <= 0) return null;
  return [Math.round(e.range[0] / rate), Math.round(e.range[1] / rate)];
}
