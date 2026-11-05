-- Backfill the four original niches with the fields the audit found missing:
-- opening hours, build time, site type, customer market, prerequisites and a
-- demand score. These are starting estimates and are labelled as such.
update niches set card = jsonb_set(card, '{model}', (card->'model') || jsonb_build_object(
  'openHoursPerMonth', 60, 'siteType', 'house', 'buildMonths', '{"own": {"low": 6, "mode": 9, "high": 14}, "lease": {"low": 2, "mode": 3, "high": 5}}'::jsonb,
  'basis', 'Starting estimates from the original research conversation; not yet sourced.',
  'streams', (select jsonb_agg(s || '{"market":"destination"}'::jsonb) from jsonb_array_elements(card->'model'->'streams') s)))
  || jsonb_build_object('prerequisites', '["Quiet site away from road noise", "Permission to run short-stay lodging"]'::jsonb, 'demand_score', 5, 'demand_evidence', 'Starting estimate; not yet checked against sources.')
where slug = 'dark-retreat';
update niches set card = jsonb_set(card, '{model}', (card->'model') || jsonb_build_object(
  'openHoursPerMonth', 208, 'siteType', 'commercial', 'buildMonths', '{"own": {"low": 8, "mode": 12, "high": 18}, "lease": {"low": 3, "mode": 5, "high": 8}}'::jsonb,
  'basis', 'Starting estimates from the original research conversation; not yet sourced.',
  'streams', (select jsonb_agg(s || '{"market":"local"}'::jsonb) from jsonb_array_elements(card->'model'->'streams') s)))
  || jsonb_build_object('prerequisites', '["Public-use or agritourism permission for day visitors", "Water supply and septic sized for public showers", "Road access and parking for day visitors"]'::jsonb, 'demand_score', 6, 'demand_evidence', 'Starting estimate; not yet checked against sources.')
where slug = 'nature-bathhouse';
update niches set card = jsonb_set(card, '{model}', (card->'model') || jsonb_build_object(
  'openHoursPerMonth', 40, 'siteType', 'estate', 'buildMonths', '{"own": {"low": 8, "mode": 12, "high": 18}, "lease": {"low": 2, "mode": 3, "high": 5}}'::jsonb,
  'basis', 'Starting estimates from the original research conversation; not yet sourced.',
  'streams', (select jsonb_agg(s || '{"market":"destination"}'::jsonb) from jsonb_array_elements(card->'model'->'streams') s)))
  || jsonb_build_object('prerequisites', '["Lodging for 10-20 guests and a group practice space", "Retreat or event use permitted"]'::jsonb, 'demand_score', 5, 'demand_evidence', 'Starting estimate; not yet checked against sources.')
where slug = 'retreat-venue-rental';
update niches set card = jsonb_set(card, '{model}', (card->'model') || jsonb_build_object(
  'openHoursPerMonth', 60, 'siteType', 'estate', 'buildMonths', '{"own": {"low": 6, "mode": 9, "high": 14}, "lease": {"low": 3, "mode": 5, "high": 8}}'::jsonb,
  'basis', 'Starting estimates from the original research conversation; not yet sourced.',
  'streams', (select jsonb_agg(s || '{"market":"destination"}'::jsonb) from jsonb_array_elements(card->'model'->'streams') s)))
  || jsonb_build_object('prerequisites', '["Campground or glamping permit", "Several flat acres with water and power"]'::jsonb, 'demand_score', 5, 'demand_evidence', 'Starting estimate; not yet checked against sources.')
where slug = 'wellness-glamping';
