// Where the tests find the PLATO repository (examples) and the DEEP exports (optional, large).
// CI checks PLATO out at the pinned commit and sets PLATO_REPO; DEEP tests skip without the data.
export const PLATO_REPO = process.env.PLATO_REPO || '../place-attestation-ontology';
export const DEEP_EXPORT = process.env.DEEP_EXPORT || '../deep/data/export';
