// Radar da Plateia — funções puras do motor (sem DOM, sem câmera). Testadas em tests/engine.test.mjs.

export const SCORE_MIN = 0.38; // abaixo disso o rosto é "suspeito": desenha apagado, não conta, não avisa
export const valido = (t) => (t.score ?? 0) >= SCORE_MIN;

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/** Fração da caixa `a` que está dentro de `b`. */
export function contencao(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3]);
}

/** Remove detecções duplicadas: sobreposição alta OU caixa quase toda contida em outra (mesmo rosto). */
export function dedupe(dets) {
  const ordem = [...dets].sort((a, b) => b.score - a.score);
  const unicos = [];
  for (const d of ordem) {
    const dup = unicos.some(u => iou(d.box, u.box) >= 0.35 || contencao(d.box, u.box) > 0.7);
    if (!dup) unicos.push(d);
  }
  return unicos;
}

/** pitch cai quando a cabeça baixa; yaw desloca quando vira pro lado. kps: [olhoD, olhoE, nariz, ...] */
export function geometria(kps) {
  if (!kps || kps.length < 3) return null;
  const [re, le, no] = kps;
  const inter = Math.hypot(re[0] - le[0], re[1] - le[1]);
  if (inter < 5) return null;
  return { pitch: (no[1] - (re[1] + le[1]) / 2) / inter, yaw: (no[0] - (re[0] + le[0]) / 2) / inter };
}

export const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export const formataDur = (s) => s >= 120 ? `${Math.round(s / 60)} minutos` : `${Math.round(s)} segundos`;

/** Zonas de varredura: "medio" 2x2 de 56%, "longe" 3x3 de 40% (zoom maior alcança o fundo). */
export function zonas(W, H, alcance) {
  const n = alcance === "longe" ? 3 : alcance === "medio" ? 2 : 0;
  if (!n) return [];
  const frac = n === 3 ? 0.40 : 0.56;
  const tw = Math.round(W * frac), th = Math.round(H * frac);
  const out = [];
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++)
    out.push([Math.round(ix * (W - tw) / (n - 1)), Math.round(iy * (H - th) / (n - 1)), tw, th]);
  return out;
}

/**
 * Agrupa caixas em fileiras pela altura no quadro (embaixo = fileira 1, mais perto da câmera)
 * e numera cadeiras da esquerda pra direita. Retorna Map(item -> [fileira, cadeira]).
 */
export function fileirasECadeiras(itens) {
  const mapa = new Map();
  if (!itens.length) return mapa;
  const medH = mediana(itens.map(t => t.box[3]));
  const linhas = [];
  for (const t of [...itens].sort((a, b) => (b.box[1] + b.box[3]) - (a.box[1] + a.box[3]))) {
    const by = t.box[1] + t.box[3];
    const ult = linhas[linhas.length - 1];
    if (ult && Math.abs(ult.y - by) <= medH * 0.9) {
      ult.itens.push(t);
      ult.y = ult.itens.reduce((s, i) => s + i.box[1] + i.box[3], 0) / ult.itens.length;
    } else linhas.push({ y: by, itens: [t] });
  }
  linhas.forEach((linha, fi) => {
    [...linha.itens].sort((a, b) => (a.box[0] + a.box[2] / 2) - (b.box[0] + b.box[2] / 2))
      .forEach((t, ci) => mapa.set(t, [fi + 1, ci + 1]));
  });
  return mapa;
}

/** Nota da sessão a partir da taxa (0-1) de gente "ok". */
export function classificarNota(taxa) {
  if (taxa == null || Number.isNaN(taxa)) return { rotulo: "sem dados", cor: "neutro" };
  if (taxa >= 0.85) return { rotulo: "ótima", cor: "ok" };
  if (taxa >= 0.70) return { rotulo: "boa", cor: "ok" };
  if (taxa >= 0.50) return { rotulo: "regular", cor: "warn" };
  return { rotulo: "fraca", cor: "alerta" };
}

/** Resumo numérico da sessão: amostras = [{t, pessoas, ok, alerta, ruido}], avisos = [{t, texto}]. */
export function resumoSessao(sessao, agoraS) {
  const am = sessao.amostras;
  const duracaoS = Math.max(0, (agoraS ?? (am.length ? am[am.length - 1].t : sessao.inicio)) - sessao.inicio);
  const somaOk = am.reduce((s, a) => s + a.ok, 0), somaAlerta = am.reduce((s, a) => s + a.alerta, 0);
  const taxa = somaOk + somaAlerta ? somaOk / (somaOk + somaAlerta) : null;
  const comAlerta = am.filter(a => a.alerta > 0).length;
  const ruidos = am.map(a => a.ruido).filter(r => r != null);
  return {
    duracaoS,
    pico: am.reduce((m, a) => Math.max(m, a.pessoas), 0),
    mediaPessoas: am.length ? am.reduce((s, a) => s + a.pessoas, 0) / am.length : 0,
    taxa,
    minutosComAlerta: (comAlerta * sessao.passoS) / 60,
    avisos: sessao.avisos.length,
    ruidoMedio: ruidos.length ? ruidos.reduce((s, r) => s + r, 0) / ruidos.length : null,
    nota: classificarNota(taxa),
  };
}

/** CSV pro Excel em português: BOM + ponto-e-vírgula. Amostras e avisos na mesma tabela (coluna tipo). */
export function csvRelatorio(sessao, modo, fmtHora = (t) => String(t)) {
  const sep = ";";
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const linhas = [["hora", "tipo", "modo", "pessoas", "ok", "alerta", "taxa_pct", "ruido", "mensagem"].join(sep)];
  for (const a of sessao.amostras) {
    const taxa = a.ok + a.alerta ? Math.round(100 * a.ok / (a.ok + a.alerta)) : "";
    linhas.push([fmtHora(a.t), "amostra", modo, a.pessoas, a.ok, a.alerta, taxa, a.ruido ?? "", ""].map(esc).join(sep));
  }
  for (const v of sessao.avisos) {
    linhas.push([fmtHora(v.t), "aviso", modo, "", "", "", "", "", v.texto].map(esc).join(sep));
  }
  return "﻿" + linhas.join("\r\n") + "\r\n";
}
