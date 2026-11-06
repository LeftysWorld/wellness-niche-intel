-- The scout wrote proxies its own notes flagged as the wrong measure. Put the
-- estimates back (new rows supersede; nothing is edited). The guarded scout
-- will look again and only replace these with real figures.
insert into assumptions (subject_type, subject_id, key, value_num, low, high, unit, currency, source_url, source_note, confidence, written_by, stale_after)
select 'location', l.id, v.key, v.val, v.lo, v.hi, v.unit, v.cur, null, v.note, 'low', 'system:estimate-restored', interval '30 days'
from (values
  ('us', 'labor.monthly_wage_usd', 2800::numeric, 2400::numeric, 3400::numeric, 'usd_per_month', 'USD',
   'Estimate restored: the scouted $8,128 was the all-industry average total compensation ($46.89/h), not a rural hospitality wage.'),
  ('us-wv-morgan-berkeley-springs', 'lease.estate_monthly_usd', 3675, 2500, 6000, 'usd_per_month', 'USD',
   'Estimate restored (2.5x the house lease): the scouted $27,480 was a nightly vacation rate x 30, not a long-term lease.'),
  ('us-wv-morgan-berkeley-springs', 'demand.population_40min', 150000, 120000, 250000, 'people', null,
   'Estimate restored: the scouted 17,142 was Morgan County alone; a 40-minute drive also reaches Berkeley County (Martinsburg).'),
  ('co-ant-el-retiro', 'demand.population_40min', 3000000, null, null, 'people', null,
   'Estimate restored: the scouted 20,700 was El Retiro town alone; a 40-minute drive reaches Rionegro, La Ceja and the edge of Medellin.')
) as v(slug, key, val, lo, hi, unit, cur, note)
join locations l on l.slug = v.slug;
