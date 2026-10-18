// Aura de la forja y del botín (Módulo J).
//
// Un ítem forjado brilla cuando pasa de +7. El tramo decide el color: hasta +9 el
// brillo es frío, plateado; de +10 en adelante se vuelve dorado y rojo, el aviso
// de que esa pieza ya pega de verdad. Los tramos son los mismos que cortan las
// gemas en el servidor, pero aquí solo importan los colores: el cliente no
// decide nada, pinta lo que le llega.

export const ENHANCE_GLOW_TIERS = [
  {
    from: 7,
    to: 9,
    inner: 0xdfe7ff,
    outer: 0x4fc3f7,
    alpha: 0.45,
    scale: 1.5
  },
  {
    from: 10,
    to: 15,
    inner: 0xffe082,
    outer: 0xff5252,
    alpha: 0.6,
    scale: 1.75
  }
];

// Aura de un botín según su rareza. El común no brilla: si todo brillara, el
// brillo no diría nada.
export const RARITY_GLOWS = {
  magico: { inner: 0xbfe9ff, outer: 0x4fc3f7, alpha: 0.38, scale: 1.3 },
  raro: { inner: 0xffe9a8, outer: 0xffd54f, alpha: 0.46, scale: 1.4 },
  legendario: { inner: 0xffc266, outer: 0xff9800, alpha: 0.58, scale: 1.55 }
};

// Aura que le toca a un nivel de forja, o null si el ítem todavía no brilla
export function glowTierFor(level) {
  const valor = Number(level) || 0;

  return ENHANCE_GLOW_TIERS.find((tier) => valor >= tier.from && valor <= tier.to) || null;
}

// Aura que le toca a una rareza, o null si no le toca ninguna
export function rarityGlowFor(rarityKey) {
  return RARITY_GLOWS[rarityKey] || null;
}

// '#4fc3f7' -> 0x4fc3f7, para los tintes de Phaser. Un color que no sea un HEX de
// seis cifras se ignora en vez de romper el dibujo.
export function parseColor(hex) {
  if (typeof hex !== 'string') return null;

  const limpio = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(limpio)) return null;

  return parseInt(limpio, 16);
}
