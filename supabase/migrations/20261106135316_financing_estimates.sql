-- Starting estimates for the new financing and land-lease inputs (marked as
-- estimates, so the scout keeps looking for real figures).
insert into assumptions (subject_type, subject_id, key, value_num, low, high, unit, currency, source_url, source_note, confidence, written_by, stale_after)
select 'location', l.id, v.key, v.val, v.lo, v.hi, v.unit, null, null, v.note, 'low', 'seed:estimate', interval '180 days'
from (values
  ('finance.seller_down_pct', 0.4::numeric, 0.3::numeric, 0.5::numeric, 'share', 'Estimate: typical down payment when a land seller finances the rest'),
  ('finance.seller_rate_pct', 8, 6, 12, 'percent', 'Estimate: typical interest on seller-financed land'),
  ('finance.seller_term_years', 7, 3, 10, 'years', 'Estimate: typical term of seller-financed land')
) as v(key, val, lo, hi, unit, note)
cross join locations l
where l.level = 'country' and l.country_code in ('CO', 'CR', 'SV');

insert into assumptions (subject_type, subject_id, key, value_num, low, high, unit, currency, source_url, source_note, confidence, written_by, stale_after)
values ('global', null, 'lease.ground_rent_yield_pct', 0.06, 0.04, 0.08, 'share per year', null, null,
  'Estimate: yearly ground rent as a share of land value, used until a place has a scouted land rent', 'low', 'seed:estimate', interval '365 days');
