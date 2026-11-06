-- Same restore for Berkeley Springs (the previous migration used the wrong slug).
insert into assumptions (subject_type, subject_id, key, value_num, low, high, unit, currency, source_url, source_note, confidence, written_by, stale_after)
select 'location', l.id, v.key, v.val, v.lo, v.hi, v.unit, v.cur, null, v.note, 'low', 'system:estimate-restored', interval '30 days'
from (values
  ('lease.estate_monthly_usd', 3675::numeric, 2500::numeric, 6000::numeric, 'usd_per_month', 'USD',
   'Estimate restored (2.5x the house lease): the scouted $27,480 was a nightly vacation rate x 30, not a long-term lease.'),
  ('demand.population_40min', 150000, 120000, 250000, 'people', null,
   'Estimate restored: the scouted 17,142 was Morgan County alone; a 40-minute drive also reaches Berkeley County (Martinsburg).')
) as v(key, val, lo, hi, unit, cur, note)
join locations l on l.slug = 'us-west-virginia-berkeley-springs-morgan-county';
