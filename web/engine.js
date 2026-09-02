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

/**
 * Remove detecções duplicadas: sobreposição alta OU caixa quase toda contida em outra (mesmo rosto/pessoa).
 * criterio "score" (rostos) fica com a mais confiante; "area" (pessoas) fica com a MAIOR — o recorte por zona
 * corta o corpo e a caixa parcial (sem cabeça) costuma ter score maior que a inteira.
 */
export function dedupe(dets, criterio = "score") {
  const area = (d) => d.box[2] * d.box[3];
  const ordem = [...dets].sort(criterio === "area" ? (a, b) => area(b) - area(a) : (a, b) => b.score - a.score);
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

// ------------------------------------------------------------------ Modo Segurança: EPI por cor (herdado do Monitor de EPI, 08/2026)

/** Limiares por rigor: fração mínima de pixels da região que precisa "parecer" o EPI. */
export const RIGOR_EPI = {
  tolerante: { colete: 0.07, capaceteCor: 0.14, capaceteBranco: 0.28 },
  normal:    { colete: 0.10, capaceteCor: 0.18, capaceteBranco: 0.34 },
  rigoroso:  { colete: 0.15, capaceteCor: 0.25, capaceteBranco: 0.42 },
};

/** RGB 0-255 -> [matiz 0-360, saturação 0-1, valor 0-1]. */
export function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

/**
 * Pixel de alta visibilidade: amarelo-verde fluorescente (matiz 50-100) ou laranja (10-50) MUITO saturado.
 * Pele fica em matiz 10-45 com saturação até ~0.65: o laranja exige s >= 0.70 pra pele bronzeada/sombreada não virar colete.
 */
export const altaVisibilidade = (h, s, v) =>
  (h >= 50 && h <= 100 && s >= 0.45 && v >= 0.45) || (h >= 10 && h < 50 && s >= 0.70 && v >= 0.55);

/** Frações de cor numa região RGBA (Uint8ClampedArray). `passo` = amostra 1 a cada N pixels. */
export function analisarCores(data, passo = 2) {
  let n = 0, colete = 0, capaceteCor = 0, capaceteBranco = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * passo) {
    const [h, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]);
    n++;
    if (altaVisibilidade(h, s, v)) colete++;
    if (s >= 0.45 && v >= 0.40) capaceteCor++;
    if (v >= 0.80 && s <= 0.20) capaceteBranco++;
  }
  return { n, colete: n ? colete / n : 0, capaceteCor: n ? capaceteCor / n : 0, capaceteBranco: n ? capaceteBranco / n : 0 };
}

/**
 * Onde procurar cada EPI dentro da caixa da pessoa. Caixa alta e estreita (h/w >= 2) = corpo inteiro em pé,
 * torso fica mais no alto; caixa mais quadrada = meio corpo (câmera de mesa/parede perto).
 */
export function regioesEpi([x, y, w, h]) {
  const inteiro = h / w >= 2;
  return inteiro
    ? { colete: [x + 0.18 * w, y + 0.14 * h, 0.64 * w, 0.24 * h], capacete: [x + 0.28 * w, y, 0.44 * w, 0.11 * h] }
    : { colete: [x + 0.18 * w, y + 0.28 * h, 0.64 * w, 0.34 * h], capacete: [x + 0.28 * w, y + 0.01 * h, 0.44 * w, 0.19 * h] };
}

/**
 * Regiões ANCORADAS no rosto (bem mais robusto que a proporção da caixa, que erra em pessoa sentada/perto da câmera):
 * capacete = da testa pra cima; colete = abaixo do queixo/pescoço, largura de ombros. Tudo recortado à caixa da pessoa.
 * `torsoVisivel`/`cabecaVisivel` = false quando a região quase não cabe no quadro (pessoa colada na câmera ou cortada):
 * aí a leitura daquele item é INDEFINIDA — nunca vira "sem colete" falso.
 */
export function regioesEpiPorRosto([x, y, w, h], [fx, fy, fw, fh]) {
  const cx = fx + fw / 2;
  const clip = ([rx, ry, rw, rh]) => { // origem presa dentro da caixa, tamanho mínimo 1px
    const x1 = Math.min(Math.max(rx, x), x + w - 1), y1 = Math.min(Math.max(ry, y), y + h - 1);
    const x2 = Math.min(rx + rw, x + w), y2 = Math.min(ry + rh, y + h);
    return [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
  };
  const colete = clip([cx - 1.2 * fw, fy + 1.25 * fh, 2.4 * fw, 1.7 * fh]);
  const capacete = clip([cx - 0.7 * fw, fy - 0.85 * fh, 1.4 * fw, 0.95 * fh]);
  return { colete, capacete, torsoVisivel: colete[3] >= 0.35 * fh, cabecaVisivel: capacete[3] >= 0.3 * fh };
}

/** Rosto que pertence à pessoa: centro dentro da caixa, na metade de cima; se houver mais de um, o maior. */
export function rostoDaPessoa([x, y, w, h], rostos) {
  let melhor = null;
  for (const r of rostos) {
    const b = r.box || r;
    const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    if (cx < x || cx > x + w || cy < y || cy > y + 0.65 * h) continue;
    if (!melhor || b[2] > melhor[2]) melhor = b;
  }
  return melhor;
}

/** Uma amostra (um quadro): frações do torso e do topo viram tem/não tem por item, segundo o rigor. */
export function amostraEpi({ torso, topo }, rigor = "normal") {
  const R = RIGOR_EPI[rigor] || RIGOR_EPI.normal;
  return {
    colete: torso.colete >= R.colete,
    capacete: topo.capaceteCor >= R.capaceteCor || topo.capaceteBranco >= R.capaceteBranco,
  };
}

/**
 * Estado suavizado da pessoa: item "tem" se >= 2 das últimas 6 amostras LIDAS disseram tem (a leitura por cor falha
 * em quadro isolado). Amostra null = região fora do quadro, não conta pra nenhum lado. Menos de 3 amostras (ou menos
 * de 3 lidas de um item) = indefinido. `obrigatorios` = {colete, capacete}.
 * conforme: true (tudo ok) | false (falta algo) | null (ainda lendo / sem leitura de item obrigatório).
 */
export function estadoEpi(hist, obrigatorios) {
  const rec = hist.slice(-6);
  if (rec.length < 3) return { conforme: null, faltando: [], indefinidos: [] };
  const faltando = [], indefinidos = [];
  for (const item of ["colete", "capacete"]) {
    if (!obrigatorios?.[item]) continue;
    const lidos = rec.filter(a => a && a[item] != null);
    if (lidos.length < 3) { indefinidos.push(item); continue; }
    if (lidos.filter(a => a[item]).length < 2) faltando.push(item);
  }
  return { conforme: faltando.length ? false : indefinidos.length ? null : true, faltando, indefinidos };
}

export const rotuloEpi = (faltando) => faltando.length ? "SEM " + faltando.map(f => f.toUpperCase()).join(" E ") : "";
export const fraseEpi = (faltando) => faltando.join(" e ");

/** Casa tracks com detecções pelo maior IoU (greedy). Devolve os pares e as detecções que sobraram. */
export function casarPorIou(tracks, dets, minIou = 0.25) {
  const cand = [];
  for (const t of tracks) for (const d of dets) { const v = iou(t.box, d.box); if (v >= minIou) cand.push([v, t, d]); }
  cand.sort((a, b) => b[0] - a[0]);
  const usadosT = new Set(), usadosD = new Set(), pares = [];
  for (const [, t, d] of cand) {
    if (usadosT.has(t) || usadosD.has(d)) continue;
    usadosT.add(t); usadosD.add(d); pares.push([t, d]);
  }
  return { pares, livres: dets.filter(d => !usadosD.has(d)) };
}
