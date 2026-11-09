import { useEffect, useState } from 'react';
import { callAgent, supabase } from '../supabase.ts';
import { FilterLayout, useFilters } from '../filters.tsx';
import { Err, Loading, Section, useLoad } from '../ui.tsx';

const WEIGHT_LABELS: Record<string, string> = {
  money: 'Year-1 take-home vs target',
  growth: 'Year-3 take-home vs target',
  capital: 'Fundable with my cash',
  workload: 'Little paid help needed',
  demand: 'Evidence of demand',
  place: 'Place matches my description',
  visa: 'Residency route',
  risk: 'Country risk',
  evidence: 'Sourced data',
};
const LOAN_TYPES = ['sba', 'usda', 'local_bank'];

/** Every setting on this page, so the filter panel can narrow them down. */
interface Item {
  section: string;
  label: string;
  hint: string;
}
const ITEMS: Item[] = [
  { section: 'My goal', label: 'Monthly target (USD)', hint: 'take-home profit money goal' },
  { section: 'My goal', label: 'By year after opening', hint: 'year 1 year 3 goal' },
  { section: 'My goal', label: 'Compare the target with', hint: 'tax after before income' },
  { section: 'Money and work', label: 'Cash I can put in (USD)', hint: 'capital savings money' },
  { section: 'Money and work', label: 'Own or lease', hint: 'buy rent property land ground lease build structures' },
  { section: 'Money and work', label: 'Borrow to buy land', hint: 'loan bank sba usda financing usa lease 7a' },
  { section: 'Money and work', label: 'Seller financing abroad', hint: 'loan seller owner financing colombia costa rica el salvador land' },
  { section: 'Money and work', label: 'Live on site', hint: 'home house residence living' },
  { section: 'Money and work', label: 'My housing cost today (USD/month)', hint: 'rent mortgage housing living' },
  { section: 'Money and work', label: 'Cost to build my home on the land (USD)', hint: 'house home a-frame build own land live on site' },
  { section: 'Money and work', label: "Hours a month I'll work on site", hint: 'workload time owner' },
  { section: 'Money and work', label: 'Who runs it', hint: 'staff team solo help' },
  ...Object.values(WEIGHT_LABELS).map((label) => ({ section: 'How ideas are scored', label, hint: 'weight score ranking' })),
];

export function Settings() {
  const { data, error } = useLoad(async () => {
    const { data, error } = await supabase.from('parameter_profiles').select('id,name,params').eq('is_default', true).single();
    if (error) throw error;
    return data;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [p, setP] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const f = useFilters<Item>({
    tab: 'settings',
    noun: 'settings',
    views: [
      { label: 'All settings' },
      { label: 'My goal', criteria: { enums: { section: ['My goal'] } } },
      { label: 'Money and work', criteria: { enums: { section: ['Money and work'] } } },
      { label: 'How ideas are scored', criteria: { enums: { section: ['How ideas are scored'] } } },
    ],
    rows: ITEMS,
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (i) => `${i.label} ${i.hint}` },
      { key: 'section', label: 'Section', type: 'enum', group: 'Settings', get: (i) => i.section, order: ['My goal', 'Money and work', 'How ideas are scored'] },
    ],
  });
  const shown = new Set(f.rows.map((i) => i.label));
  const vis = (label: string) => shown.has(label);
  const anyIn = (section: string) => f.rows.some((i) => i.section === section);
  useEffect(() => {
    if (data) setP(structuredClone(data.params));
  }, [data]);
  if (error) return <Err error={error} />;
  if (!p) return <Loading />;

  const set = (k: string, v: unknown) => setP({ ...p, [k]: v });
  const loans = (p.financing_allowed ?? []).some((f: string) => LOAN_TYPES.includes(f));

  async function save() {
    setMsg('Saving…');
    const { error } = await supabase.from('parameter_profiles').update({ params: p }).eq('id', data!.id);
    if (error) return setMsg(error.message);
    setMsg('Saved. Re-ranking ideas with the new settings…');
    try {
      await callAgent('fit-screen');
      setMsg('Saved. Re-ranking runs in the background; refresh Business ideas in a minute or two.');
    } catch (e) {
      setMsg(`Saved. Re-ranking failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <FilterLayout f={f}>
    <div className="settings">
      {anyIn('My goal') && (
      <Section title="My goal">
        <div className="row">
          {vis('Monthly target (USD)') && (
          <label>
            Monthly target (USD)
            <input type="number" value={p.target_monthly_profit_usd ?? 5000} onChange={(e) => set('target_monthly_profit_usd', Number(e.target.value))} />
          </label>
          )}
          {vis('By year after opening') && (
          <label>
            By year after opening
            <select value={p.target_year ?? 1} onChange={(e) => set('target_year', Number(e.target.value))}>
              <option value={1}>Year 1</option>
              <option value={3}>Year 3</option>
            </select>
          </label>
          )}
          {vis('Compare the target with') && (
          <label>
            Compare the target with
            <select value={p.target_basis ?? 'after_tax'} onChange={(e) => set('target_basis', e.target.value)}>
              <option value="after_tax">Take-home after income tax</option>
              <option value="with_housing">Take-home plus the housing I save living on site</option>
              <option value="pre_tax">Profit before income tax</option>
            </select>
          </label>
          )}
        </div>
      </Section>
      )}
      {anyIn('Money and work') && (
      <Section title="Money and work">
        <div className="row">
          {vis('Cash I can put in (USD)') && (
          <label>
            Cash I can put in (USD)
            <input type="number" value={p.capital_usd?.max ?? 150000} onChange={(e) => set('capital_usd', { ...p.capital_usd, max: Number(e.target.value) })} />
          </label>
          )}
          {vis('Own or lease') && (
          <label>
            Property
            <select value={p.own_or_lease ?? 'either'} onChange={(e) => set('own_or_lease', e.target.value)}>
              <option value="either">Compare all three</option>
              <option value="lease">Lease an existing property</option>
              <option value="ground">Rent land and build my own structures</option>
              <option value="own">Buy land and build</option>
            </select>
          </label>
          )}
          {vis('Borrow to buy land') && (
          <label>
            Borrow in the USA
            <select
              value={loans ? 'yes' : 'no'}
              onChange={(e) => {
                const rest = (p.financing_allowed ?? []).filter((f: string) => !LOAN_TYPES.includes(f));
                set('financing_allowed', e.target.value === 'yes' ? [...rest, 'sba', 'usda'] : rest);
              }}
            >
              <option value="yes">Yes: SBA or bank loan to buy, or SBA 7(a) for a lease, if a lender would approve</option>
              <option value="no">No, cash only</option>
            </select>
          </label>
          )}
          {vis('Seller financing abroad') && (
          <label>
            Seller financing abroad
            <select
              value={(p.financing_allowed ?? []).includes('seller') ? 'yes' : 'no'}
              onChange={(e) => {
                const rest = (p.financing_allowed ?? []).filter((f: string) => f !== 'seller');
                set('financing_allowed', e.target.value === 'yes' ? [...rest, 'seller'] : rest);
              }}
            >
              <option value="no">No, cash only outside the USA</option>
              <option value="yes">Assume the land seller finances part (about 40% down, 7 years, 8%)</option>
            </select>
          </label>
          )}
        </div>
        <div className="row">
          {vis('Live on site') && (
          <label>
            Live on site
            <select value={p.live_on_site ? 'yes' : 'no'} onChange={(e) => set('live_on_site', e.target.value === 'yes')}>
              <option value="yes">Yes, I'll live there</option>
              <option value="no">No</option>
            </select>
          </label>
          )}
          {vis('My housing cost today (USD/month)') && (
          <label>
            My housing cost today (USD/month)
            <input type="number" min={0} value={p.housing_cost_usd ?? 0} onChange={(e) => set('housing_cost_usd', Number(e.target.value))} />
            <small className="muted">Rent or mortgage you'd stop paying. Lenders count it when you live on site; it can also count toward your target (above).</small>
          </label>
          )}
          {vis('Cost to build my home on the land (USD)') && (
          <label>
            Cost to build my home on the land (USD)
            <input type="number" min={0} value={p.home_build_usd ?? 0} onChange={(e) => set('home_build_usd', Number(e.target.value))} />
            <small className="muted">Your own house when you buy land and live on site. Kept apart from the business: shown as your cash including the home.</small>
          </label>
          )}
        </div>
        <div className="row">
          {vis("Hours a month I'll work on site") && (
          <label>
            Hours a month I'll work on site
            <input type="number" value={p.owner_hours_per_month ?? 220} onChange={(e) => set('owner_hours_per_month', Number(e.target.value))} />
          </label>
          )}
          {vis('Who runs it') && (
          <label>
            Who runs it
            <select value={p.operator_model ?? 'solo'} onChange={(e) => set('operator_model', e.target.value)}>
              <option value="solo">Me, with paid help only for hours I can't cover</option>
              <option value="team">A team (the niche's usual staff)</option>
            </select>
          </label>
          )}
        </div>
      </Section>
      )}
      {anyIn('How ideas are scored') && (
      <Section title="How ideas are scored">
        <p className="muted small">The Business ideas page sorts by money by default; the overall score is a second view that uses these weights.</p>
        {Object.keys(WEIGHT_LABELS).filter((k) => vis(WEIGHT_LABELS[k])).map((k) => (
          <label key={k} className="slider">
            <span>
              {WEIGHT_LABELS[k]} <b>{Math.round((p.weights?.[k] ?? 0) * 100)}</b>
            </span>
            <input type="range" min={0} max={0.5} step={0.05} value={p.weights?.[k] ?? 0} onChange={(e) => set('weights', { ...p.weights, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </Section>
      )}
      <div className="actions">
        <button onClick={save}>Save settings</button>
        {msg && <small className="muted">{msg}</small>}
      </div>
    </div>
    </FilterLayout>
  );
}
