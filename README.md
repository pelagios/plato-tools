# PLATO tools

Browser tools that check and convert data about places in the formats of
[PLATO](https://pelagios.org/place-attestation-ontology/guide/), the Place Attestation Ontology:
PLATO spreadsheet tables (CSV on the Web), PLATO JSON, RDF, and Linked Places Format v1.

Everything runs in your browser. Your files are never uploaded, and the tools are built to
handle datasets of any size your disk can hold: see [the spike](spike/README.md) for how that was
established on the 24.8-million-triple DEEP dataset.

**Status: in development.**

## What it checks against

The tools vendor PLATO's normative files (ontology, JSON Schemas, JSON-LD context, table
definitions) from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and in `public/plato/VERSION.json`. `npm run vendor` re-pins to the
current head.

## Development

```bash
npm install
npm test            # conversion tests, against jsonld.js and the PLATO examples
npm run dev         # local server
npm run build       # static site in dist/
```

## Licence

BSD 3-Clause. PLATO itself is CC BY 4.0.
