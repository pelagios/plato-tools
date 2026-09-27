// The page's own account of progress, polled by the harness (never a library event).
window.__spike = { phase: 'idle' };
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const status = document.getElementById('status');
worker.onmessage = (e) => {
  Object.assign(window.__spike, e.data, { elapsedMs: Math.round(performance.now() - window.__spike.t0) });
  status.textContent = JSON.stringify(window.__spike, null, 1);
};
worker.onerror = (e) => { window.__spike.phase = 'error'; window.__spike.message = 'worker error: ' + e.message; };
document.getElementById('start').onclick = () => {
  const file = document.getElementById('file').files[0];
  const mode = document.getElementById('mode').value;
  if (!file) { status.textContent = 'choose a file'; return; }
  window.__spike = { phase: 'starting', mode, t0: performance.now(), inputBytes: file.size };
  const q = new URLSearchParams(location.search);
  const opt = { memdb: q.has('memdb'), cacheMB: +q.get('cacheMB') || 64, pageSize: +q.get('pageSize') || 0 };
  worker.postMessage({ file, mode, opt });
};
window.__download = async () => {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle('spike-out.jsonl')).getFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = 'spike-out.jsonl'; a.click();
  return file.size;
};
document.getElementById('dl').onclick = () => window.__download();
window.__ready = true;
