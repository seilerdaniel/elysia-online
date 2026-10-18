// Registro de zonas (Módulo I). El servidor es la autoridad: aquí viven el
// tamaño, los portales, los monstruos y el punto de aparición de cada mapa.
//
// El cliente dibuja las puertas con los mismos datos que le manda el servidor al
// entrar (evento mapInfo), así que este archivo es la única fuente de verdad: si
// una puerta se mueve aquí, el cliente la dibuja en su sitio nuevo sin tocar
// nada más.

// Cuadrícula de 100 x 100 tiles de 32 px. El cliente usa los mismos 3200 px como
// límites del mundo y de la cámara.
const MAP_SIZE = 3200;

const DEFAULT_MAP_ID = 1;

// Los identificadores de monstruo son únicos en todo el juego: el cliente los
// usa como clave del grupo de sprites, así que no pueden repetirse entre mapas.
const MAPS = {
  1: {
    id: 1,
    name: 'Ciudad de Ullathorpe',
    spawn: { x: 1600, y: 1600 },
    monsters: [
      {
        id: 'm1', name: 'Trasgo', x: 900, y: 800, hp: 120, xp: 40, gold: 25,
        drops: [
          { itemKey: 'potion_health', chance: 0.40 },
          { itemKey: 'sword_iron', chance: 0.15 },
          { itemKey: 'gem_light', chance: 0.05 }
        ]
      },
      {
        id: 'm2', name: 'Orco', x: 2400, y: 1000, hp: 190, xp: 80, gold: 50,
        drops: [
          { itemKey: 'potion_mana', chance: 0.35 },
          { itemKey: 'shield_oak', chance: 0.12 },
          { itemKey: 'soul_sphere', chance: 0.03 }
        ]
      },
      {
        id: 'm3', name: 'Demonio', x: 2300, y: 2400, hp: 300, xp: 150, gold: 100,
        drops: [
          { itemKey: 'plate_armor', chance: 0.08 },
          { itemKey: 'soul_sphere', chance: 0.08 },
          { itemKey: 'chaos_stone', chance: 0.02 }
        ]
      }
    ],
    // La puerta norte de la ciudad baja al sur del bosque. El destino queda a
    // 140 px del portal de allá (radio 90): al llegar no se vuelve a activar.
    portals: [
      {
        id: 'puerta_norte',
        name: 'Bosque Nublado',
        x: 1600,
        y: 120,
        radius: 90,
        targetMapId: 2,
        targetX: 1600,
        targetY: 2940
      }
    ]
  },

  2: {
    id: 2,
    name: 'Bosque Nublado',
    spawn: { x: 1600, y: 1600 },
    monsters: [
      {
        id: 'm4', name: 'Lobo Sombrío', x: 800, y: 2200, hp: 170, xp: 65, gold: 35,
        drops: [
          { itemKey: 'potion_health', chance: 0.30 },
          { itemKey: 'gem_light', chance: 0.10 },
          { itemKey: 'soul_sphere', chance: 0.04 }
        ]
      },
      {
        id: 'm5', name: 'Araña Gigante', x: 2100, y: 900, hp: 150, xp: 55, gold: 30,
        drops: [
          { itemKey: 'potion_mana', chance: 0.30 },
          { itemKey: 'shield_oak', chance: 0.08 },
          { itemKey: 'chaos_stone', chance: 0.02 }
        ]
      },
      {
        id: 'm6', name: 'Ent Centinela', x: 1500, y: 2500, hp: 400, xp: 200, gold: 130,
        drops: [
          { itemKey: 'plate_armor', chance: 0.10 },
          { itemKey: 'soul_sphere', chance: 0.10 },
          { itemKey: 'chaos_stone', chance: 0.04 }
        ]
      }
    ],
    portals: [
      {
        id: 'senda_sur',
        name: 'Ciudad de Ullathorpe',
        x: 1600,
        y: 3080,
        radius: 90,
        targetMapId: 1,
        targetX: 1600,
        targetY: 260
      }
    ]
  }
};

// Nombre de la sala de Socket.io de un mapa: el censo, el movimiento, el combate
// y el chat solo viajan entre los jugadores que están en la misma zona.
function mapRoom(mapId) {
  return `map_${mapId}`;
}

// Un mapa desconocido (base de datos vieja o manipulada) cae al mapa inicial
function mapById(mapId) {
  return MAPS[Number(mapId)] || MAPS[DEFAULT_MAP_ID];
}

function portalsOf(mapId) {
  return mapById(mapId).portals;
}

// Un portal se activa pisando su radio. El servidor comprueba la distancia con
// sus propias coordenadas: las que mande el cliente no cuentan.
function portalInRange(portal, x, y) {
  return Math.hypot(x - portal.x, y - portal.y) <= portal.radius;
}

// Primer portal del mapa actual que lleva al mapa pedido y que el personaje
// está pisando, o null
function findPortal(mapId, targetMapId, x, y) {
  return portalsOf(mapId).find(
    (portal) => portal.targetMapId === Number(targetMapId) && portalInRange(portal, x, y)
  ) || null;
}

function clampToMap(value) {
  return Math.min(MAP_SIZE, Math.max(0, value));
}

module.exports = {
  MAP_SIZE,
  DEFAULT_MAP_ID,
  MAPS,
  mapRoom,
  mapById,
  portalsOf,
  portalInRange,
  findPortal,
  clampToMap
};
