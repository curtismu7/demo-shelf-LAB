// Parses the standalone-demo-family plan's tables into catalog items. Pure and deterministic:
// same text in, same items out. Sections it reads: "Catalog" (active, by "### X." group),
// "Suggested order (waves)", "Backlog", "Retired ids".
const ID_ROW = /^\|\s*([A-H]\d{1,2})\s*\|/;
const SEEDS = [['✅', 'built'], ['🟡', 'partial'], ['❌', 'none']];

const clean = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function seedOf(cell) {
  for (const [mark, word] of SEEDS) if (cell?.includes(mark)) return word;
  return null;
}

export function parseCatalog(markdown) {
  const lines = markdown.split('\n');
  let section = '';
  let group = null;
  const groupNames = {};
  const rows = []; // { id, name, kind, seed, status }
  const waveOf = new Map();

  for (const line of lines) {
    const h2 = line.match(/^## (.*)/);
    if (h2) {
      const t = h2[1];
      section = /^Catalog:/.test(t) ? 'catalog' : /^Suggested order/.test(t) ? 'waves' : /^Backlog/.test(t) ? 'backlog' : /^Retired ids/.test(t) ? 'retired' : '';
      group = null;
      continue;
    }
    const h3 = line.match(/^### ([A-H])\. (.*)/);
    if (h3 && section === 'catalog') { group = h3[1]; groupNames[group] = clean(h3[2]); continue; }

    if (section === 'waves') {
      const m = line.match(/^\|\s*(\d+|Backlog)\s*\|(.*)\|\s*$/);
      if (!m) continue;
      const wave = m[1] === 'Backlog' ? 'backlog' : Number(m[1]);
      for (const id of m[2].match(/\b[A-H]\d{1,2}\b/g) || []) if (!waveOf.has(id)) waveOf.set(id, wave);
      continue;
    }

    const m = line.match(ID_ROW);
    if (!m || !section || section === 'waves') continue;
    const c = cells(line);
    if (section === 'catalog' && !group) continue;
    rows.push({
      id: m[1],
      name: clean(c[1] ?? ''),
      kind: section === 'catalog' ? clean(c[2] ?? '') || null : null,
      seed: section === 'retired' ? null : seedOf(c[c.length - 1]),
      status: section === 'catalog' ? 'active' : section,
    });
  }

  const order = (id) => id.charCodeAt(0) * 1000 + Number(id.slice(1));
  const items = rows
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, group: r.id[0], seed: r.seed, wave: r.status === 'retired' ? null : waveOf.get(r.id) ?? null, status: r.status }))
    .sort((a, b) => order(a.id) - order(b.id));
  const dup = items.map((i) => i.id).filter((id, n, all) => all.indexOf(id) !== n);
  if (dup.length) throw new Error(`catalog ids appear in more than one table: ${[...new Set(dup)].join(', ')}`);
  return { schema: 'demo-shelf-catalog/1', groups: groupNames, items };
}
