-- match_niches ignored min_similarity and always returned the closest niche,
-- so unrelated ideas were treated as duplicates. Apply the threshold.
create or replace function match_niches(q text, min_similarity real default 0.3, max_rows int default 8)
returns table (id uuid, slug text, name text, status niche_status, similarity real)
language sql stable set search_path = public, extensions as $$
  select * from (
    select n.id, n.slug, n.name, n.status,
           greatest(similarity(n.name, q), coalesce((select max(similarity(a, q)) from unnest(n.aliases) a), 0)) as similarity
    from niches n where n.status <> 'rejected'
  ) m
  where m.similarity >= min_similarity
  order by m.similarity desc limit max_rows
$$;
