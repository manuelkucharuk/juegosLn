// Interfaz: tablero, teclado, panel de letras y listados.
"use strict";

const TOP = 5;
const CYCLE = { 0: 2, 2: 1, 1: 0 }; // gris → celeste → amarillo → gris
// Mejor apertura por cantidad de letras (máxima entropía, calculada con tools/build_words.py)
const BEST_OPENER = { 5: "careo", 6: "careto", 7: "cetrino" };

const state = {
  n: 5,
  history: [], // [{word, states}]
  letters: [],
  states: [],
  runId: 0,
};

const $ = (id) => document.getElementById(id);

function normalizeKey(key) {
  if (key.length !== 1) return null;
  const k = key.toLowerCase();
  if (k === "ñ") return k;
  const plain = k.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /^[a-z]$/.test(plain) ? plain : null;
}

// Conocimiento acumulado: celestes por posición y mejor estado de cada letra.
function knowledge() {
  const greenAt = new Array(state.n).fill(null);
  const best = {};
  for (const { word, states } of state.history) {
    [...word].forEach((c, i) => {
      if (states[i] === 2) greenAt[i] = c;
      best[c] = Math.max(best[c] ?? 0, states[i]);
    });
  }
  return { greenAt, best };
}

// Sin amarillo automático: celeste si ya fue celeste en esa posición, si no gris.
function autoState(letter, pos) {
  return knowledge().greenAt[pos] === letter ? 2 : 0;
}

function typeLetter(letter) {
  if (state.letters.length >= state.n) return;
  state.states.push(autoState(letter, state.letters.length));
  state.letters.push(letter);
  render();
}

function backspace() {
  state.letters.pop();
  state.states.pop();
  render();
}

function setWord(word) {
  state.letters = [];
  state.states = [];
  [...word].forEach(typeLetter);
}

function accept() {
  if (state.letters.length !== state.n) {
    $("status").textContent = `Completá las ${state.n} letras.`;
    return;
  }
  state.history.push({ word: state.letters.join(""), states: state.states });
  state.letters = [];
  state.states = [];
  render();
  analyze();
}

function reset() {
  state.history = [];
  state.letters = [];
  state.states = [];
  render();
  analyze();
}

function setMode(n) {
  state.n = n;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", +b.dataset.n === n));
  reset();
}

// --- Render ---

function tile(letter, s, onClick, cursor) {
  const el = document.createElement("div");
  el.className = "tile";
  if (letter) {
    el.textContent = letter;
    el.classList.add("filled", `s${s}`);
    el.addEventListener("click", onClick);
  } else if (cursor) {
    el.classList.add("cursor");
  }
  return el;
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();
  state.history.forEach((row, r) => {
    const el = document.createElement("div");
    el.className = "row past";
    [...row.word].forEach((c, i) =>
      el.append(tile(c, row.states[i], () => {
        // Corregir un turno anterior recalcula todo
        row.states = row.states.map((s, j) => (j === i ? CYCLE[s] : s));
        render();
        analyze();
      }))
    );
    board.append(el);
  });
  const solved = state.history.length && state.history.at(-1).states.every((s) => s === 2);
  if (solved) return;
  const el = document.createElement("div");
  el.className = "row";
  for (let i = 0; i < state.n; i++) {
    const letter = state.letters[i];
    el.append(tile(letter, state.states[i], () => {
      state.states[i] = CYCLE[state.states[i]];
      render();
    }, i === state.letters.length));
  }
  board.append(el);
}

function renderLetters() {
  const { best } = knowledge();
  const groups = { in: [], out: [], unused: [] };
  for (const c of Solver.ALPHABET) {
    if (!(c in best)) groups.unused.push(c);
    else if (best[c] > 0) groups.in.push(c);
    else groups.out.push(c);
  }
  const panel = $("letters");
  panel.replaceChildren();
  const section = (title, list) => {
    const h = document.createElement("h3");
    h.textContent = title;
    const keys = document.createElement("div");
    keys.className = "keys";
    for (const c of list) {
      const b = document.createElement("button");
      b.className = "key" + (c in best ? ` s${best[c]}` : "");
      b.textContent = c;
      b.addEventListener("click", () => typeLetter(c));
      keys.append(b);
    }
    panel.append(h, keys);
  };
  section("En la palabra", groups.in);
  section("Descartadas", groups.out);
  section("Sin usar", groups.unused);
  const bs = document.createElement("button");
  bs.className = "key backspace";
  bs.textContent = "⌫ Borrar";
  bs.addEventListener("click", backspace);
  panel.append(bs);
}

function renderOpener() {
  const el = $("opener");
  el.hidden = state.history.length > 0;
  el.querySelector("button").textContent = BEST_OPENER[state.n];
}

function render() {
  renderBoard();
  renderLetters();
  renderOpener();
  $("status").textContent = "";
}

function fmtProb(p) {
  if (p <= 0) return "–";
  const pct = p * 100;
  if (pct < 0.01) return "<0,01%";
  return pct.toFixed(pct < 1 ? 2 : 1).replace(".", ",") + "%";
}

function fmtNum(x, d) {
  return x.toFixed(d).replace(".", ",");
}

function renderTable(id, rows) {
  const table = $(id);
  table.replaceChildren();
  if (!rows.length) {
    table.innerHTML = '<tr><td class="empty">Sin resultados</td></tr>';
    return;
  }
  table.innerHTML = "<tr><th>Palabra</th><th>Prob.</th><th>Bits</th><th>Restan</th></tr>";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const word = document.createElement("td");
    word.className = "word" + (r.prob > 0 ? " cand" : "");
    word.textContent = r.word;
    word.title = "Usar esta palabra";
    word.addEventListener("click", () => setWord(r.word));
    tr.append(word);
    for (const text of [fmtProb(r.prob), fmtNum(r.bits, 2), fmtNum(r.remaining, 1)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    table.append(tr);
  }
}

async function analyze() {
  const runId = ++state.runId;
  const progress = $("progress");
  const bar = progress.firstElementChild;
  $("count").textContent = "Calculando…";
  bar.style.width = "0";
  const result = await Solver.analyze(state.n, state.history, TOP, (f) => {
    if (runId !== state.runId) return;
    progress.hidden = false;
    bar.style.width = `${f * 100}%`;
  });
  if (runId !== state.runId) return; // hubo un cambio mientras calculaba
  progress.hidden = true;
  const solved = state.history.length && state.history.at(-1).states.every((s) => s === 2);
  $("count").textContent = solved
    ? "¡Resuelto!"
    : result.count === 0
      ? "No queda ninguna palabra compatible. Revisá los colores."
      : `${result.count} palabra${result.count === 1 ? "" : "s"} posible${result.count === 1 ? "" : "s"}`;
  renderTable("probable", result.probable);
  renderTable("best", result.best);
  renderTable("best-candidates", result.bestCandidates);
}

// --- Eventos ---

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter") {
    e.preventDefault();
    accept();
  } else if (e.key === "Backspace") {
    e.preventDefault();
    backspace();
  } else {
    const letter = normalizeKey(e.key);
    if (letter) {
      e.preventDefault();
      typeLetter(letter);
    }
  }
});

// En celulares, tocar el tablero abre el teclado virtual.
$("board").addEventListener("click", (e) => {
  if (!e.target.classList.contains("filled")) $("mobile-input").focus();
});
$("mobile-input").addEventListener("input", (e) => {
  for (const ch of e.target.value) {
    const letter = normalizeKey(ch);
    if (letter) typeLetter(letter);
  }
  e.target.value = "";
});

$("opener").querySelector("button").addEventListener("click", () => setWord(BEST_OPENER[state.n]));
$("accept").addEventListener("click", accept);
$("reset").addEventListener("click", reset);
document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(+b.dataset.n)));

setMode(5);
