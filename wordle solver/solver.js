// Lógica del resolvedor: patrones, filtrado y entropía de Shannon.
// Estados de casilla: 0 gris, 1 amarillo, 2 celeste. Un patrón es sum(estado_i * 3^i).
"use strict";

const Solver = (() => {
  const ALPHABET = "abcdefghijklmnñopqrstuvwxyz";
  // Debe coincidir con tools/build_words.py
  const PRIOR_CENTER = 3.0;
  const PRIOR_SCALE = 2.0;
  const CHUNK = 200;

  const cache = {};

  function load(n) {
    if (cache[n]) return cache[n];
    const entries = window.WORDS[n].split(" ");
    const words = new Array(entries.length);
    const prior = new Float64Array(entries.length);
    const codes = new Uint8Array(entries.length * n);
    entries.forEach((entry, i) => {
      const [w, z] = entry.split(":");
      words[i] = w;
      prior[i] = 1 / (1 + Math.exp(-(parseFloat(z) - PRIOR_CENTER) * PRIOR_SCALE));
      for (let j = 0; j < n; j++) codes[i * n + j] = ALPHABET.indexOf(w[j]);
    });
    return (cache[n] = { n, words, prior, codes, index: new Map(words.map((w, i) => [w, i])) });
  }

  function encode(word) {
    return Uint8Array.from(word, (c) => ALPHABET.indexOf(c));
  }

  // Patrón de `guess` contra la respuesta en codes[a*n ...]; maneja letras repetidas.
  const avail = new Uint8Array(ALPHABET.length);
  function pattern(guess, codes, a, n) {
    const base = a * n;
    avail.fill(0);
    for (let i = 0; i < n; i++) if (guess[i] !== codes[base + i]) avail[codes[base + i]]++;
    let code = 0;
    let pow = 1;
    for (let i = 0; i < n; i++) {
      const c = guess[i];
      if (c === codes[base + i]) code += 2 * pow;
      else if (avail[c] > 0) {
        avail[c]--;
        code += pow;
      }
      pow *= 3;
    }
    return code;
  }

  function patternOf(states) {
    return states.reduce((acc, s, i) => acc + s * 3 ** i, 0);
  }

  // Índices de palabras compatibles con todo el historial [{word, states}].
  function candidates(vocab, history) {
    const { n, words, codes } = vocab;
    let result = words.map((_, i) => i);
    for (const { word, states } of history) {
      const g = encode(word);
      const p = patternOf(states);
      result = result.filter((a) => pattern(g, codes, a, n) === p);
    }
    return result;
  }

  // Calcula probabilidad, bits y promedio restante para cada palabra de `guesses`
  // sobre las candidatas `cands`. Asíncrono por trozos para no bloquear la página.
  async function score(vocab, guesses, cands, onProgress) {
    const { n, codes, prior } = vocab;
    const total = cands.reduce((s, a) => s + prior[a], 0);
    const prob = new Map(cands.map((a) => [a, prior[a] / total]));
    const size = 3 ** n;
    const pMass = new Float64Array(size);
    const count = new Uint32Array(size);
    const touched = new Int32Array(Math.min(size, cands.length));
    const results = [];
    for (let start = 0; start < guesses.length; start += CHUNK) {
      for (const gi of guesses.slice(start, start + CHUNK)) {
        const g = codes.subarray(gi * n, gi * n + n);
        let used = 0;
        for (const a of cands) {
          const p = pattern(g, codes, a, n);
          if (count[p] === 0) touched[used++] = p;
          count[p]++;
          pMass[p] += prob.get(a);
        }
        let bits = 0;
        let remaining = 0;
        for (let k = 0; k < used; k++) {
          const p = touched[k];
          const m = pMass[p];
          bits -= m * Math.log2(m);
          remaining += m * count[p];
          pMass[p] = 0;
          count[p] = 0;
        }
        results.push({ idx: gi, prob: prob.get(gi) || 0, bits, remaining });
      }
      if (onProgress) onProgress(Math.min(1, (start + CHUNK) / guesses.length));
      await new Promise((r) => setTimeout(r, 0));
    }
    return results;
  }

  // Devuelve los tres listados: más probables, mejores en general, mejores entre candidatas.
  async function analyze(n, history, top, onProgress) {
    const vocab = load(n);
    const cands = candidates(vocab, history);
    const toRow = (r) => ({ word: vocab.words[r.idx], prob: r.prob, bits: r.bits, remaining: r.remaining });

    if (history.length === 0 && window.OPENERS && window.OPENERS[n]) {
      const fromOpener = (rows) => rows.map(([word, prob, bits, remaining]) => ({ word, prob, bits, remaining }));
      const o = window.OPENERS[n];
      return {
        count: cands.length,
        probable: fromOpener(o.probable),
        best: fromOpener(o.best),
        bestCandidates: fromOpener(o.bestCandidates),
      };
    }
    if (cands.length === 0) return { count: 0, probable: [], best: [], bestCandidates: [] };

    const all = vocab.words.map((_, i) => i);
    const scored = await score(vocab, cands.length === 1 ? cands : all, cands, onProgress);
    const isCand = new Set(cands);
    const byBits = (a, b) => b.bits - a.bits || b.prob - a.prob;
    const candRows = scored.filter((r) => isCand.has(r.idx));
    return {
      count: cands.length,
      probable: [...candRows].sort((a, b) => b.prob - a.prob).slice(0, top).map(toRow),
      best: [...scored].sort(byBits).slice(0, top).map(toRow),
      bestCandidates: candRows.sort(byBits).slice(0, top).map(toRow),
    };
  }

  return { load, analyze, ALPHABET };
})();
