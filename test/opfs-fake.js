// A fake of the browser's private file storage (OPFS) for the tests: folders of files held in memory,
// with getFileHandle, createWritable (a WritableStream that writes the file when closed), removeEntry and entries.
export function fakeOpfs() {
  const dirs = new Map();
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const dirHandle = (files) => ({
    async getFileHandle(name, { create } = {}) {
      if (!files.has(name)) { if (!create) throw notFound(); files.set(name, new Uint8Array(0)); }
      return {
        async getFile() { if (!files.has(name)) throw notFound(); return new File([files.get(name)], name); },
        async createWritable() {
          const parts = [];
          return new WritableStream({ write(c) { parts.push(c); }, close() { files.set(name, new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x))))); } });
        },
      };
    },
    async removeEntry(name) { if (!files.delete(name)) throw notFound(); },
    async *entries() { for (const name of [...files.keys()]) yield [name, { kind: 'file', ...(await this.getFileHandle(name)) }]; },
  });
  const root = {
    async getDirectoryHandle(name, { create } = {}) { if (!dirs.has(name)) { if (!create) throw notFound(); dirs.set(name, new Map()); } return dirHandle(dirs.get(name)); },
    async *entries() { for (const name of [...dirs.keys()]) yield [name, { kind: 'directory', name }]; },
    async removeEntry(name) { if (!dirs.delete(name)) throw notFound(); },
  };
  return { dirs, root: async () => root };
}
