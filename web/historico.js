// Histórico de sessões no navegador (IndexedDB). Só metadados e séries numéricas — nenhuma imagem. Testado no e2e.
const DB = "radar-plateia", STORE = "sessoes";

function abrir() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(modo, fn) {
  const db = await abrir();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, modo);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req ? req.result : undefined); };
    t.onerror = () => { db.close(); rej(t.error); };
    t.onabort = () => { db.close(); rej(t.error || new Error("transação abortada")); };
  });
}
export const salvarSessao = (reg) => tx("readwrite", s => s.put(reg));
export const listarSessoes = async () => ((await tx("readonly", s => s.getAll())) || []).sort((a, b) => b.inicioWall - a.inicioWall);
export const apagarSessao = (id) => tx("readwrite", s => s.delete(id));
export const limparSessoes = () => tx("readwrite", s => s.clear());
