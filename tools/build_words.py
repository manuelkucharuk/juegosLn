"""Genera words.js: vocabulario español de 5, 6 y 7 letras con frecuencias,
más los listados del primer turno precomputados (el cálculo más caro).

Uso:
    python -m pip install wordfreq numpy
    python tools/build_words.py ruta/a/index.dic

index.dic: diccionario Hunspell español de https://unpkg.com/dictionary-es@4.0.0/index.dic
Solo se usan las entradas con marcas de afijo ("casa/S", "cantar/RED"): son formas
base (singular, masculino, infinitivo). Las entradas sin marcas son en su mayoría
conjugaciones irregulares o formas con enclíticos ("puede", "dales"), y se descartan.
"""
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
from wordfreq import zipf_frequency

LENGTHS = (5, 6, 7)
MAX_PER_LENGTH = 10000
TOP = 5
# Debe coincidir con solver.js
PRIOR_CENTER = 3.0
PRIOR_SCALE = 2.0

ROOT = Path(__file__).resolve().parent.parent
VALID = re.compile(r"^[a-zñ]+$")


def normalize(word):
    """Minúsculas, sin tildes ni diéresis, pero conservando la ñ."""
    word = word.lower().replace("ñ", "\0")
    word = "".join(c for c in unicodedata.normalize("NFD", word) if unicodedata.category(c) != "Mn")
    return word.replace("\0", "ñ")


def prior(zipf):
    return 1 / (1 + math.exp(-(zipf - PRIOR_CENTER) * PRIOR_SCALE))


def read_lemmas(dic_path):
    """Formas base del .dic de Hunspell: entradas con marcas de afijo, en minúscula."""
    lines = Path(dic_path).read_text(encoding="utf-8").splitlines()[1:]
    return {stem for stem, sep, _ in (line.partition("/") for line in lines) if sep and stem.islower()}


def build_vocab(lemmas):
    vocab = {n: {} for n in LENGTHS}
    for raw in lemmas:
        word = normalize(raw)
        if len(word) not in vocab or not VALID.match(word):
            continue
        # Variantes que colapsan al quitar tildes (ej. "papa"/"papá") suman frecuencia.
        # Las palabras que wordfreq no conoce quedan con frecuencia mínima.
        freq = 10 ** zipf_frequency(raw, "es")
        bucket = vocab[len(word)]
        bucket[word] = bucket.get(word, 0) + freq
    result = {}
    for n, bucket in vocab.items():
        ranked = sorted(bucket.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_PER_LENGTH]
        result[n] = [(w, round(math.log10(f), 2)) for w, f in ranked]
    return result


def encode(words, alphabet):
    return np.array([[alphabet[c] for c in w] for w in words], dtype=np.int8)


def patterns_for(guess, answers):
    """Código base 3 de cada respuesta para `guess` (0 gris, 1 amarillo, 2 celeste)."""
    n, length = answers.shape
    green = answers == guess
    # available[c]: apariciones de la letra c en la respuesta fuera de las celestes
    available = {}
    for c in set(guess.tolist()):
        available[c] = ((answers == c) & ~green).sum(1)
    code = np.zeros(n, dtype=np.int32)
    for i in range(length):
        c = guess[i]
        yellow = ~green[:, i] & (available[c] > 0)
        available[c] = available[c] - yellow
        code += np.where(green[:, i], 2, np.where(yellow, 1, 0)) * 3 ** i
    return code


def score_all(words, zipfs):
    alphabet = {c: i for i, c in enumerate("abcdefghijklmnñopqrstuvwxyz")}
    enc = encode(words, alphabet)
    weights = np.array([prior(z) for z in zipfs])
    weights /= weights.sum()
    length = enc.shape[1]
    n_patterns = 3 ** length
    bits = np.zeros(len(words))
    remaining = np.zeros(len(words))
    for gi in range(len(words)):
        code = patterns_for(enc[gi], enc)
        p = np.bincount(code, weights=weights, minlength=n_patterns)
        cnt = np.bincount(code, minlength=n_patterns)
        nz = p > 0
        bits[gi] = -(p[nz] * np.log2(p[nz])).sum()
        remaining[gi] = (p * cnt).sum()
    return weights, bits, remaining


def row(words, i, weights, bits, remaining):
    return [words[i], round(float(weights[i]), 6), round(float(bits[i]), 3), round(float(remaining[i]), 1)]


def main():
    vocab = build_vocab(read_lemmas(sys.argv[1]))
    out_words, openers = {}, {}
    for n in LENGTHS:
        words = [w for w, _ in vocab[n]]
        zipfs = [z for _, z in vocab[n]]
        print(f"{n} letras: {len(words)} palabras, ej: {words[:10]}", flush=True)
        out_words[n] = " ".join(f"{w}:{z}" for w, z in vocab[n])
        weights, bits, remaining = score_all(words, zipfs)
        by_bits = np.argsort(-bits)[:TOP]
        openers[n] = {
            "probable": [row(words, i, weights, bits, remaining) for i in np.argsort(-weights)[:TOP]],
            "best": [row(words, i, weights, bits, remaining) for i in by_bits],
            # Sin pistas, toda palabra es candidata
            "bestCandidates": [row(words, i, weights, bits, remaining) for i in by_bits],
        }
        print(f"  mejores aperturas: {[r[0] for r in openers[n]['best']]}", flush=True)
    js = (
        "// Generado por tools/build_words.py — no editar a mano.\n"
        "// Formato: 'palabra:zipf' separados por espacio, ordenados por frecuencia.\n"
        f"window.WORDS = {json.dumps(out_words, ensure_ascii=False)};\n"
        f"window.OPENERS = {json.dumps(openers, ensure_ascii=False)};\n"
    )
    (ROOT / "words.js").write_text(js, encoding="utf-8")
    print(f"words.js: {len(js.encode('utf-8')) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
