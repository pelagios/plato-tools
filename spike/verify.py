"""Check the spike's JSON Lines against the N-Triples it came from, independently of the spike.

1. Totals: one line per SpatialEntity-typed subject, and every attestation accounted for,
   against counts taken from the N-Triples by a different program (awk).
2. Content: for sample entities, rebuild the entity's own triples, its attestations' triples and
   their facet nodes' triples from the N-Triples by plain string matching, and compare with the
   triples implied by the spike's JSON for the same entity.
Controls: the comparator must say SAME for a sample compared with itself, and DIFFERENT when one
triple is removed from the JSON side.
"""
import gzip, json, re, sys
NT, OUT = sys.argv[1], sys.argv[2]
EXPECT_ENTITIES, EXPECT_ATTS = int(sys.argv[3]), int(sys.argv[4])
P = 'https://w3id.org/plato#'
TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
ABOUT, LABEL = P + 'attests_about', 'http://www.w3.org/2000/01/rdf-schema#label'
FACETS = {P + x for x in ('attests_name', 'attests_geometry', 'attests_timespan', 'attests_type', 'attests_property', 'has_citation')}
XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
TRIPLE = re.compile(r'^(<[^>]*>|_:\S+)\s+<([^>]*)>\s+(.*?)\s*\.\s*$')

def term(t):
    """N-Triples object -> (kind, value, datatype, lang)."""
    if t.startswith('<'): return ('iri', t[1:-1], None, None)
    if t.startswith('_:'): return ('bnode', t, None, None)
    m = re.match(r'^"(.*)"(?:\^\^<([^>]*)>|@([A-Za-z0-9-]+))?$', t, re.S)
    v = json.loads('"' + m.group(1) + '"')      # N-Triples escapes are a subset of JSON's
    dt = m.group(2) if m.group(2) and m.group(2) != XSD_STRING else None
    return ('lit', v, dt, m.group(3))
def subj(s): return s[1:-1] if s.startswith('<') else s
def lines():
    with gzip.open(NT, 'rt', encoding='utf-8') as f:
        for line in f:
            if line and line[0] != '#':
                m = TRIPLE.match(line)
                if m: yield subj(m.group(1)), m.group(2), m.group(3)

# pass 1: pick samples (label-based, and one by position), find their attestations
wanted_labels = {'"Bunsty Hundred"', '"Cambridge"'}
labelled, about, entities_in_order = {}, {}, []
for s, p, o in lines():
    if p == LABEL and o in wanted_labels: labelled.setdefault(o, []).append(s)
    elif p == ABOUT: about.setdefault(o[1:-1], []).append(s)
    elif p == TYPE and o == f'<{P}SpatialEntity>': entities_in_order.append(s)
samples = []
for lab, ids in labelled.items():
    samples.append(max(ids, key=lambda e: len(about.get(e, []))))   # the one with most attestations
samples.append(entities_in_order[len(entities_in_order) * 3 // 4])
atts = {a: e for e in samples for a in about.get(e, [])}
print('samples:', [(e, len(about.get(e, []))) for e in samples])
# pass 2: triples of samples and of their attestations; facet objects to fetch
expected = {e: set() for e in samples}; facet_of = {}
for s, p, o in lines():
    owner = s if s in expected else atts.get(s)
    if owner is None: continue
    expected[owner].add((s, p) + term(o))
    if s in atts and p in FACETS: facet_of.setdefault(o[1:-1] if o.startswith('<') else o, set()).add(owner)
# pass 3: facet nodes' triples
for s, p, o in lines():
    for owner in facet_of.get(s, ()):
        expected[owner].add((s, p) + term(o))

def json_triples(rec):
    out = set()
    def val(v):
        if isinstance(v, str): return ('lit', v, None, None)
        if '@id' in v: return (('bnode' if v['@id'].startswith('_:') else 'iri'), v['@id'], None, None)
        return ('lit', v['@value'], v.get('@type'), v.get('@language'))
    def node(nid, obj):
        for p, vs in obj.items():
            if p in ('@id', 'attestations'): continue
            for v in vs:
                out.add((nid, p) + val(v))
                if isinstance(v, dict) and '@id' in v and p in FACETS: node(v['@id'], v)
    node(rec['@id'], rec)
    for a in rec['attestations']: node(a['@id'], a)
    return out

def compare(a, b):
    return 'SAME' if a == b else f'DIFFERENT (only expected {len(a - b)}, only in output {len(b - a)})'

n = total_atts = 0; found = {}
with open(OUT, encoding='utf-8') as f:
    for line in f:
        rec = json.loads(line); n += 1; total_atts += len(rec['attestations'])
        if rec['@id'] in expected: found[rec['@id']] = json_triples(rec)
ok = True
def check(name, cond, detail=''):
    global ok
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -- ' + detail) if detail else ''}"); ok &= bool(cond)
check('one line per SpatialEntity', n == EXPECT_ENTITIES, f'{n} lines, expected {EXPECT_ENTITIES}')
check('every attestation accounted for', total_atts == EXPECT_ATTS, f'{total_atts}, expected {EXPECT_ATTS}')
for e in samples:
    got = found.get(e)
    check(f'{e}: present in output', got is not None)
    if got is None: continue
    check(f'{e}: {len(expected[e])} triples match the N-Triples', compare(expected[e], got) == 'SAME', compare(expected[e], got))
e0 = samples[0]
check('control: comparator says SAME for a sample against itself', compare(expected[e0], set(expected[e0])) == 'SAME')
perturbed = set(found.get(e0, set())); perturbed.discard(next(iter(perturbed), None))
check('control: comparator says DIFFERENT when one triple is removed', compare(expected[e0], perturbed) != 'SAME')
print('VERIFY', 'ALL PASS' if ok else 'FAILED'); sys.exit(0 if ok else 1)
