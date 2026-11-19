'use strict';

const MIN_LENGTH = 4;
const ALPHABET = 'abcdefghijklmnñopqrstuvwxyz';

const cells = [...document.querySelectorAll('.hex')];
const centerCell = document.querySelector('.hex.center');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const groupsEl = document.getElementById('groups');
const previewEl = document.getElementById('preview');
const dropzoneEl = document.getElementById('dropzone');
const fileEl = document.getElementById('file');

/* ---------- Diccionario ---------- */

// Minúsculas sin acentos ni diéresis, conservando la ñ.
function normalize(text) {
  return text.normalize('NFC').toLowerCase()
    .replace(/ñ/g, '#')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/#/g, 'ñ');
}

function maskOf(word) {
  let mask = 0;
  for (const ch of word) mask |= 1 << ALPHABET.indexOf(ch);
  return mask;
}

function buildDictionary(list) {
  const seen = new Set();
  const words = [];
  for (const line of list.split('\n')) {
    const original = line.trim();
    // Descarta nombres propios, símbolos y abreviaturas (D.D.T).
    if (!/^\p{Ll}+$/u.test(original)) continue;
    const normal = normalize(original);
    if (normal.length < MIN_LENGTH || !/^[a-zñ]+$/.test(normal) || seen.has(normal)) continue;
    seen.add(normal);
    words.push({ original, length: normal.length, mask: maskOf(normal) });
  }
  return words;
}

const DICTIONARY = buildDictionary(window.LISTADO);

/* ---------- Búsqueda y resultados ---------- */

function findWords(center, letters) {
  const panelMask = maskOf(letters.join(''));
  const centerMask = maskOf(center);
  const byLengthThenName = (a, b) => b.length - a.length || a.original.localeCompare(b.original, 'es');
  const found = DICTIONARY
    .filter(w => (w.mask & centerMask) && !(w.mask & ~panelMask))
    .sort(byLengthThenName);
  return {
    superpacks: found.filter(w => w.mask === panelMask),
    others: found.filter(w => w.mask !== panelMask),
  };
}

function renderGroup(title, words, className) {
  const section = document.createElement('section');
  section.className = `word-group ${className}`;
  const heading = document.createElement('h2');
  heading.textContent = `${title} (${words.length})`;
  const list = document.createElement('div');
  list.className = 'words';
  for (const word of words) {
    const item = document.createElement('span');
    item.className = 'word';
    item.textContent = word.original;
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function update() {
  groupsEl.replaceChildren();
  const letters = cells.map(cell => normalize(cell.value));
  if (letters.some(letter => !letter)) {
    summaryEl.textContent = 'Completá las 7 letras para ver las palabras.';
    return;
  }
  if (new Set(letters).size < letters.length) {
    summaryEl.textContent = 'Hay letras repetidas en el panal.';
    return;
  }

  const { superpacks, others } = findWords(normalize(centerCell.value), letters);
  const total = superpacks.length + others.length;
  if (!total) {
    summaryEl.textContent = 'No hay palabras para este panal.';
    return;
  }
  summaryEl.textContent = `${total} ${total === 1 ? 'palabra' : 'palabras'}, ` +
    `${superpacks.length} ${superpacks.length === 1 ? 'superpack' : 'superpacks'}.`;

  groupsEl.append(renderGroup('Superpacks', superpacks, 'superpack'));

  const lengths = [...new Set(others.map(w => w.length))];
  for (const length of lengths) {
    groupsEl.append(renderGroup(`${length} letras`, others.filter(w => w.length === length), ''));
  }
}

/* ---------- Reconocimiento de letras ---------- */

const GRID = 32;              // Lado de la grilla donde se compara cada letra.
const INK_LUMINANCE = 100;    // Más oscuro que esto es tinta de letra.
const MIN_INK_AREA = 4;       // Grupos menores son ruido.
const MAX_IMAGE_SIDE = 1600;
const TEMPLATE_FONTS = ['Arial', 'Helvetica', '"Segoe UI"', 'sans-serif'];
const TEMPLATE_LETTERS = ALPHABET.toUpperCase();

function inkMap({ data, width, height }) {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) {
    const luminance = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luminance < INK_LUMINANCE) ink[i] = 1;
  }
  return ink;
}

// Cajas de las manchas de tinta conectadas.
function findComponents(ink, width, height) {
  const visited = new Uint8Array(ink.length);
  const boxes = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited[start]) continue;
    const box = { x0: width, y0: height, x1: 0, y1: 0, area: 0 };
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
      box.area++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (ink[next] && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (box.area >= MIN_INK_AREA) boxes.push(box);
  }
  return boxes;
}

// Une una mancha con la que tiene justo arriba: la tilde con el cuerpo de la Ñ.
function mergeStacked(boxes) {
  const result = boxes.map(box => ({ ...box }));
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i];
      const b = result[j];
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      const narrowest = Math.min(a.x1 - a.x0, b.x1 - b.x0) + 1;
      const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;
      const tallest = Math.max(a.y1 - a.y0, b.y1 - b.y0) + 1;
      if (overlap >= narrowest / 2 && gap <= tallest * 0.6) {
        a.x0 = Math.min(a.x0, b.x0);
        a.x1 = Math.max(a.x1, b.x1);
        a.y0 = Math.min(a.y0, b.y0);
        a.y1 = Math.max(a.y1, b.y1);
        result.splice(j, 1);
        j = i;
      }
    }
  }
  return result;
}

// Lleva la caja a la grilla conservando la proporción, para que la I siga siendo angosta.
function toGrid(ink, width, box) {
  const boxWidth = box.x1 - box.x0 + 1;
  const boxHeight = box.y1 - box.y0 + 1;
  const scale = GRID / Math.max(boxWidth, boxHeight);
  const targetWidth = Math.max(1, Math.round(boxWidth * scale));
  const targetHeight = Math.max(1, Math.round(boxHeight * scale));
  const offsetX = (GRID - targetWidth) >> 1;
  const offsetY = (GRID - targetHeight) >> 1;
  const grid = new Uint8Array(GRID * GRID);
  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = box.y0 + Math.floor(ty / scale);
    const sy1 = Math.min(box.y1 + 1, Math.max(sy0 + 1, box.y0 + Math.ceil((ty + 1) / scale)));
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = box.x0 + Math.floor(tx / scale);
      const sx1 = Math.min(box.x1 + 1, Math.max(sx0 + 1, box.x0 + Math.ceil((tx + 1) / scale)));
      let inked = 0;
      let total = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          inked += ink[sy * width + sx];
          total++;
        }
      }
      if (total && inked * 2 >= total) grid[(ty + offsetY) * GRID + tx + offsetX] = 1;
    }
  }
  return grid;
}

let templates = null;

function getTemplates() {
  if (templates) return templates;
  const size = 200;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  templates = [];
  for (const font of TEMPLATE_FONTS) {
    ctx.font = `700 110px ${font}`;
    for (const letter of TEMPLATE_LETTERS) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      ctx.fillText(letter, size / 2, size / 2);
      const ink = inkMap(ctx.getImageData(0, 0, size, size));
      const box = { x0: size, y0: size, x1: 0, y1: 0 };
      ink.forEach((value, index) => {
        if (!value) return;
        const x = index % size;
        const y = (index - x) / size;
        box.x0 = Math.min(box.x0, x);
        box.x1 = Math.max(box.x1, x);
        box.y0 = Math.min(box.y0, y);
        box.y1 = Math.max(box.y1, y);
      });
      templates.push({ letter, grid: toGrid(ink, size, box) });
    }
  }
  return templates;
}

function classify(grid) {
  let best = { letter: '', score: -1 };
  for (const template of getTemplates()) {
    let both = 0;
    let either = 0;
    for (let i = 0; i < grid.length; i++) {
      both += grid[i] & template.grid[i];
      either += grid[i] | template.grid[i];
    }
    const score = either ? both / either : 0;
    if (score > best.score) best = { letter: template.letter, score };
  }
  return best.letter;
}

// Devuelve { c, 0..5 } (central y exteriores en sentido horario desde arriba a la izquierda),
// o la cantidad de grupos encontrados si no son 7.
function recognize(imageData) {
  const { width, height } = imageData;
  const ink = inkMap(imageData);
  const boxes = mergeStacked(findComponents(ink, width, height));
  if (boxes.length !== 7) return boxes.length;

  const glyphs = boxes.map(box => ({
    box,
    x: (box.x0 + box.x1) / 2,
    y: (box.y0 + box.y1) / 2,
  }));
  const midX = glyphs.reduce((sum, g) => sum + g.x, 0) / 7;
  const midY = glyphs.reduce((sum, g) => sum + g.y, 0) / 7;
  const distance = g => Math.hypot(g.x - midX, g.y - midY);
  const center = glyphs.reduce((a, b) => (distance(b) < distance(a) ? b : a));

  // Ángulo desplazado para que el orden empiece arriba a la izquierda.
  const clockwise = g => (Math.atan2(g.y - center.y, g.x - center.x) * 180 / Math.PI + 510) % 360;
  const outer = glyphs.filter(g => g !== center).sort((a, b) => clockwise(a) - clockwise(b));

  const letters = { c: classify(toGrid(ink, width, center.box)) };
  outer.forEach((glyph, i) => { letters[i] = classify(toGrid(ink, width, glyph.box)); });
  return letters;
}

/* ---------- Entrada de la imagen ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('imagen no válida'));
    image.src = url;
  });
}

function imageToData(image) {
  const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * ratio);
  canvas.height = Math.round(image.naturalHeight * ratio);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function handleImage(blob) {
  statusEl.textContent = 'Leyendo la imagen…';
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    previewEl.src = url;
    previewEl.hidden = false;
    const letters = recognize(imageToData(image));
    if (typeof letters === 'number') {
      cells.forEach(cell => { cell.value = ''; });
      statusEl.textContent = `Encontré ${letters} grupos de letras en vez de 7. ` +
        'Recortá la imagen al panal o completá las letras a mano.';
    } else {
      cells.forEach(cell => { cell.value = letters[cell.dataset.cell]; });
      statusEl.textContent = 'Letras detectadas. Revisá que coincidan con la imagen.';
    }
  } catch (error) {
    statusEl.textContent = 'No pude leer esa imagen. Probá con otra o completá las letras a mano.';
  }
  update();
}

document.addEventListener('paste', event => {
  const item = [...event.clipboardData.items].find(entry => entry.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault();
  handleImage(item.getAsFile());
});

fileEl.addEventListener('change', () => {
  if (fileEl.files[0]) handleImage(fileEl.files[0]);
  fileEl.value = '';
});

document.addEventListener('dragover', event => {
  event.preventDefault();
  dropzoneEl.classList.add('over');
});
document.addEventListener('dragleave', () => dropzoneEl.classList.remove('over'));
document.addEventListener('drop', event => {
  event.preventDefault();
  dropzoneEl.classList.remove('over');
  const file = [...event.dataTransfer.files].find(entry => entry.type.startsWith('image/'));
  if (file) handleImage(file);
});

/* ---------- Edición de las celdas ---------- */

cells.forEach((cell, index) => {
  cell.addEventListener('focus', () => cell.select());
  cell.addEventListener('input', () => {
    const letter = normalize(cell.value).replace(/[^a-zñ]/g, '').slice(-1);
    cell.value = letter.toUpperCase();
    if (letter && cells[index + 1]) cells[index + 1].focus();
    update();
  });
});

update();
