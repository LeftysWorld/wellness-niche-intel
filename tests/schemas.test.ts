import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIBE_SCHEMA, ECONOMICS_SCHEMA, toModelAndTemplate } from '../supabase/functions/_shared/niche-schemas.ts';
import { strictSchema } from '../supabase/functions/_shared/schema.ts';
import { buildModel, mergeLedger } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';

// Structured outputs accept at most 24 optional fields across a request, need
// every object closed, and reject some JSON-schema keywords.
function walk(node: any, visit: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
}
for (const [name, schema] of [['describe', DESCRIBE_SCHEMA], ['economics', ECONOMICS_SCHEMA]] as const) {
  test(`${name} schema is valid for structured outputs`, () => {
    let optional = 0;
    walk(strictSchema(schema), (n) => {
      if (n.type === 'object') {
        assert.equal(n.additionalProperties, false);
        optional += Object.keys(n.properties ?? {}).filter((k) => !(n.required ?? []).includes(k)).length;
      }
      for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) assert.ok(!(bad in n), `${bad} not supported`);
    });
    assert.ok(optional <= 24, `${optional} optional fields`);
  });
}

test('an economics reply maps to a model the engine can run', () => {
  const t = (low: number, mode: number, high: number) => ({ low, mode, high });
  const reply = {
    ownerFixedHours: 40, openHoursPerMonth: 120, buildMonthsOwn: t(6, 9, 12), buildMonthsLease: t(2, 3, 4), siteType: 'commercial',
    variablePct: t(0.08, 0.1, 0.12), requiresPopulation: true,
    streams: [{ key: 'visits', label: 'Visits', market: 'local', units: 1, sellablePerUnitPerMonth: 800, price: t(25, 30, 35), startOccupancy: t(0.1, 0.15, 0.2), matureOccupancy: t(0.25, 0.3, 0.35), monthsToMature: t(12, 18, 24), ownerHoursPerSale: 0.02 }],
    perSale: [{ stream: 'visits', usd: t(1, 2, 3), scale: 'none' }],
    fixed: [{ key: 'insurance', label: 'Insurance', usd: t(500, 700, 900), scale: 'none', applies: 'both' }],
    staffing: [{ key: 'attendant', label: 'Attendant', wageMultiple: t(0.5, 0.6, 0.7), fromMonth: 0 }],
    exit: { sdeMultiple: t(1.5, 2, 2.5), ebitdaMultiple: t(3, 4, 5), managerWageMultiple: 1.5 },
    land_acres: 3,
    startup_items: [
      { key: 'build', label: 'Build', qty: 1, qtyFrom: '', usd: t(80000, 100000, 130000), scale: 'build', applies: 'own', leaseMonths: 0 },
      { key: 'fitout', label: 'Fit-out', qty: 1, qtyFrom: '', usd: t(30000, 40000, 50000), scale: 'build', applies: 'lease', leaseMonths: 0 },
      { key: 'deposit', label: 'Deposit', qty: 0, qtyFrom: '', usd: t(0, 0, 0), scale: 'none', applies: 'lease', leaseMonths: 2 },
    ],
  };
  const { model, template } = toModelAndTemplate(reply);
  assert.equal(model.openHoursPerMonth, 120);
  assert.equal(model.siteType, 'commercial');
  assert.equal(model.staffing[0].fromMonth, 1);
  assert.equal(template.items[2].leaseMonths, 2);
  assert.equal(template.items[0].qty, 1);
  const ledger = mergeLedger([{ scope: 'country', rows: [{ id: 'w', key: 'labor.monthly_wage_usd', value_num: 2800, value_text: null, low: null, high: null, confidence: 'high', source_url: 'https://x', written_by: 'test' }] }]);
  const built = buildModel({ niche: { slug: 'n', name: 'n', model }, template, location: { slug: 'x', name: 'x', country_code: 'US' }, ledger, profile: { capital_usd: { min: 1, max: 150000 }, financing_allowed: ['cash', 'lease'] }, tenure: 'lease' });
  const r = analyze(built.model, { simulations: 100, sensitivity: false });
  assert.ok(Number.isFinite(r.year3.takeHome.p50));
});
