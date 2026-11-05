import { useState } from 'react';
import { callAgent, supabase } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Ledger() {
  const [loc, setLoc] = useState<string>('');
  const locations = useLoad(async () => {
    const { data, error } = await supabase.from('locations').select('id,slug,name,level').order('level').order('name');
    if (error) throw error;
    return data ?? [];
  });
  const values = useLoad(async () => {
    if (!loc) return [];
    const { data, error } = await supabase.from('current_assumptions').select('*').eq('subject_type', 'location').eq('subject_id', loc).order('key');
    if (error) throw error;
    return data ?? [];
  }, [loc]);
  const [edit, setEdit] = useState<{ key: string; value: string; note: string } | null>(null);

  async function saveOverride() {
    if (!edit || !loc) return;
    const { error } = await supabase.from('assumptions').insert({
      subject_type: 'location',
      subject_id: loc,
      key: edit.key,
      value_num: Number(edit.value),
      source_note: edit.note || 'Owner override',
      confidence: 'high',
      written_by: 'user',
    });
    if (error) alert(error.message);
    setEdit(null);
    values.reload();
  }

  return (
    <Section
      title="Assumption ledger"
      actions={loc && <RunButton label="Scout this location" action={() => callAgent('location-scout', { location_id: loc })} onDone={values.reload} />}
    >
      <p className="muted small">Values are never edited in place. An override adds a new row; the old one is kept as history, and analyses that used it are re-run.</p>
      <select value={loc} onChange={(e) => setLoc(e.target.value)}>
        <option value="">Choose a location…</option>
        {(locations.data ?? []).map((l) => (
          <option key={l.id} value={l.id}>
            {l.level === 'country' ? '■ ' : '  '}
            {l.name}
          </option>
        ))}
      </select>
      <Err error={values.error ?? locations.error} />
      {loc && !values.data && <Loading />}
      {values.data && values.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Range</th>
              <th>Confidence</th>
              <th>By</th>
              <th>Retrieved</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {values.data.map((a) => (
              <tr key={a.id} className={a.is_stale ? 'stale' : ''}>
                <td>{a.key}</td>
                <td>
                  {edit?.key === a.key ? (
                    <>
                      <input value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} size={10} />
                      <input placeholder="why / source" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                      <button onClick={saveOverride}>Save</button>
                      <button onClick={() => setEdit(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      {a.value_num ?? a.value_text} {a.unit ?? ''}
                    </>
                  )}
                </td>
                <td className="muted">{a.low !== null ? `${a.low}–${a.high}` : ''}</td>
                <td>{a.confidence}</td>
                <td className="small">{a.written_by}</td>
                <td className="small">
                  {new Date(a.retrieved_at ?? a.created_at).toLocaleDateString()}
                  {a.is_stale && ' (stale)'}
                </td>
                <td className="small">{a.source_url ? <a href={a.source_url} target="_blank" rel="noreferrer">source</a> : a.source_note}</td>
                <td>{a.value_num !== null && !edit && <button onClick={() => setEdit({ key: a.key, value: String(a.value_num), note: '' })}>Override</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
