/* Générateur d'icônes PNG pour la PWA — Le Bac à Sable
   Utilisation :  node gen-icons.js
   Crée icon-192.png et icon-512.png dans le dossier courant.
   Aucune dépendance : utilise uniquement Node (zlib + fs). */

"use strict";
const fs = require("fs");
const zlib = require("zlib");

/* ---------- Encodeur PNG minimal (RGBA) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // profondeur 8 bits
  ihdr[9] = 6;   // couleur RGBA
  // Données brutes : chaque ligne précédée d'un octet de filtre (0 = aucun)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- Dessin de l'icône ---------- */
function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Police "B" en pixels (6 colonnes x 7 lignes)
const B_GLYPH = [
  "011110",
  "110011",
  "110011",
  "011110",
  "110011",
  "110011",
  "011110"
];

function drawIcon(size) {
  const k = size / 512;
  const rgba = Buffer.alloc(size * size * 4, 0);

  const bgTop = hex("#4e3fb0"), bgBot = hex("#7b62d2");
  const sandTop = hex("#ffe27a"), sandBot = hex("#f2a914");
  const navy = hex("#241a6e");
  const gold = hex("#ffd35c");

  const r = 96 * k;            // coins arrondis
  const cx = 256 * k, cy = 392 * k, rx = 160 * k, ry = 150 * k; // tas de sable
  const cell = 40 * k;          // taille d'une cellule du "B"
  const bx = (size - 6 * cell) / 2;  // centré horizontalement
  const by = 78 * k;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 1. Fond arrondi (transparent en dehors)
      const dx = Math.max(r - x, x - (size - 1 - r), 0);
      const dy = Math.max(r - y, y - (size - 1 - r), 0);
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) continue;

      let color = mix(bgTop, bgBot, y / size);

      // 2. Tas de sable (demi-ellipse)
      const ex = (x - cx) / rx, ey = (y - cy) / ry;
      if (ex * ex + ey * ey <= 1 && y <= cy) {
        color = mix(sandTop, sandBot, Math.max(0, Math.min(1, (y - cy + ry) / ry)));
      }

      // 3. Lettre "B"
      const gx = Math.floor((x - bx) / cell), gy = Math.floor((y - by) / cell);
      if (gx >= 0 && gx < 6 && gy >= 0 && gy < 7 && B_GLYPH[gy][gx] === "1") {
        color = navy;
        // petits points dorés décoratifs sur le B
        if ((gx === 4 && gy === 1) || (gx === 4 && gy === 5)) color = gold;
      }

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

for (const size of [192, 512]) {
  const name = `icon-${size}.png`;
  fs.writeFileSync(name, drawIcon(size));
  console.log(`${name} créé (${size}x${size}).`);
}
console.log("Icônes prêtes ! Ajoute-les au dossier servi par ton serveur (public/).");
