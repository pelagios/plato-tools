// Agora, part 'w3id': not written yet (see index.js for what each part is given).
export function create(ctx) {
  return {
    async finish() { ctx.rep.error('not-yet', 'This part of publishing is not written yet.'); },
  };
}
