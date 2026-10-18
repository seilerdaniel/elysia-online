// Rareza y sufijos del botín (Módulo J).
//
// Vive aparte del servidor porque es una tabla de reglas puras: el arnés de
// pruebas la importa tal cual, sin levantar sockets ni base de datos, y así se
// puede tirar el dado doscientas mil veces para comprobar la distribución.

// La rareza decide cuántos sufijos trae la pieza y qué parte del rango de cada
// sufijo se juega (un legendario tira en la parte alta, un mágico en la baja).
const RARITIES = [
  { key: 'comun', name: 'Común', color: '#ffffff', chance: 0.74, suffixes: 0, factor: [0, 0] },
  { key: 'magico', name: 'Mágico', color: '#4fc3f7', chance: 0.20, suffixes: 1, factor: [0.30, 0.60] },
  { key: 'raro', name: 'Raro', color: '#ffd54f', chance: 0.05, suffixes: 2, factor: [0.50, 0.85] },
  { key: 'legendario', name: 'Legendario', color: '#ff9800', chance: 0.01, suffixes: 3, factor: [0.75, 1.00] }
];

// Los sufijos suman sobre los atributos del personaje (fuerza, agilidad,
// inteligencia) o sobre una mecánica de combate (crítico, robo de vida,
// velocidad). Los porcentajes van en puntos enteros.
const SUFFIXES = {
  fuerza: { label: 'Fuerza', range: [3, 10], percent: false },
  agilidad: { label: 'Agilidad', range: [3, 10], percent: false },
  inteligencia: { label: 'Inteligencia', range: [3, 10], percent: false },
  'daño_critico': { label: 'Daño crítico', range: [3, 12], percent: true },
  robo_vida: { label: 'Robo de vida', range: [2, 8], percent: true },
  velocidad: { label: 'Velocidad', range: [4, 12], percent: true }
};

const SUFFIX_KEYS = Object.keys(SUFFIXES);

// Tira la rareza del botín: 74% común, 20% mágico, 5% raro, 1% legendario
function rollRarity() {
  const tirada = Math.random();
  let acumulado = 0;

  for (const rareza of RARITIES) {
    acumulado += rareza.chance;
    if (tirada < acumulado) return rareza;
  }

  return RARITIES[0];
}

// Sufijos de una pieza: sin repetir, y cada valor dentro del tramo que le toca a
// la rareza. Un sufijo repetido sería un sufijo disfrazado, así que se sortean
// distintos.
function rollBonusAttributes(rarity) {
  if (!rarity.suffixes) return {};

  const elegidos = [];

  while (elegidos.length < rarity.suffixes && elegidos.length < SUFFIX_KEYS.length) {
    const clave = SUFFIX_KEYS[Math.floor(Math.random() * SUFFIX_KEYS.length)];
    if (!elegidos.includes(clave)) elegidos.push(clave);
  }

  const [factorMin, factorMax] = rarity.factor;

  return elegidos.reduce((bonus, clave) => {
    const [minimo, maximo] = SUFFIXES[clave].range;
    const factor = factorMin + Math.random() * (factorMax - factorMin);

    bonus[clave] = Math.round(minimo + (maximo - minimo) * factor);
    return bonus;
  }, {});
}

// Botín de una pieza: el equipo puede venir bendecido, una poción nunca. El
// predicado llega desde fuera para que este módulo no tenga que saber qué tipos
// se equipan (esa tabla vive en el servidor).
function rollDropBonuses(item, isEquipable) {
  if (!isEquipable(item)) {
    return { rarity: RARITIES[0], bonusAttributes: {} };
  }

  const rarity = rollRarity();

  return { rarity, bonusAttributes: rollBonusAttributes(rarity) };
}

module.exports = {
  RARITIES,
  SUFFIXES,
  SUFFIX_KEYS,
  rollRarity,
  rollBonusAttributes,
  rollDropBonuses
};
