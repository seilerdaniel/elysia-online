// Cargar .env antes que nada: el resto del arranque depende de estas variables
require('dotenv').config();

// Variables sin las cuales el servidor no debe arrancar. Un secreto NUNCA lleva
// valor por defecto: un despliegue que olvide definirlo terminaría firmando
// tokens con una clave que cualquiera puede leer en el repositorio.
const REQUIRED_ENV = ['JWT_SECRET', 'DB_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  console.error(`❌ Faltan variables de entorno obligatorias: ${missingEnv.join(', ')}`);
  console.error('   Copia server/.env.example a server/.env y define sus valores.');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/authRoutes');
const characterRoutes = require('./routes/characterRoutes');
const clanController = require('./controllers/clanController');
const db = require('./config/db');
const {
  MAP_SIZE,
  DEFAULT_MAP_ID,
  MAPS,
  mapRoom,
  mapById,
  portalsOf,
  clampToMap
} = require('./config/maps');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET; // validado al arrancar

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/characters', characterRoutes);

// Middleware de autenticación para WebSockets
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Autenticación requerida'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Token inválido'));
    socket.user = decoded;
    socket.character = socket.handshake.auth.character;
    next();
  });
});

// Estado global en memoria
const players = {};

// --- Mapas y salas (Módulo I) -------------------------------------------------
// Cada mapa tiene su propia sala de Socket.io: el censo, el movimiento, el
// combate, el botín y el chat solo viajan entre quienes comparten zona.

function emitToMap(mapId, event, payload) {
  io.to(mapRoom(mapId)).emit(event, payload);
}

function playersInMap(mapId) {
  return Object.values(players).filter((player) => player.mapId === mapId);
}

function monstersInMap(mapId) {
  return Object.values(monsters).filter((monster) => monster.mapId === mapId);
}

// Censo de una zona con la misma forma que currentPlayers: un recién llegado
// recibe solo a los jugadores de su mapa
function playersSnapshot(mapId) {
  const snapshot = {};

  playersInMap(mapId).forEach((player) => {
    snapshot[player.playerId] = publicPlayer(player);
  });

  return snapshot;
}

// Proyección pública de una zona: nombre, tamaño, punto de aparición y puertas
function publicMap(mapId) {
  const map = mapById(mapId);

  return {
    id: map.id,
    name: map.name,
    width: MAP_SIZE,
    height: MAP_SIZE,
    spawn: map.spawn,
    portals: portalsOf(map.id)
  };
}

// Tabla de botín por monstruo (de más común a más raro).
// Se tira en orden y se detiene en el primer acierto: máximo un ítem por muerte.
// Cada monstruo sabe en qué zona vive: eso decide a quién se le cuenta.
const monsters = {};

Object.values(MAPS).forEach((map) => {
  map.monsters.forEach((spawn) => {
    monsters[spawn.id] = {
      ...spawn,
      mapId: map.id,
      maxHp: spawn.hp,
      alive: true
    };
  });
});

// Catálogo de ítems. El servidor es la fuente de verdad: ensureItemTemplates()
// sincroniza estos datos contra item_templates al arrancar y cachea los ids.
// `price` es el costo base en oro: el comerciante vende a ese precio y compra
// al 50% (ver salePrice).
const ITEM_CATALOG = {
  potion_health: {
    name: 'Poción de Vida', type: 'Pocion', spriteId: 'potion_red', price: 15,
    effect: { stat: 'hp', amount: 30 }, req: { level: 1 }
  },
  potion_mana: {
    name: 'Poción de Maná', type: 'Pocion', spriteId: 'potion_blue', price: 12,
    effect: { stat: 'mp', amount: 25 }, req: { level: 1 }
  },
  sword_iron: {
    name: 'Espada de Hierro', type: 'Arma', spriteId: 'sword', price: 100,
    req: { level: 1, fuerza: 18 }
  },
  shield_oak: {
    name: 'Escudo de Roble', type: 'Escudo', spriteId: 'shield', price: 80,
    req: { level: 1, fuerza: 15 }
  },
  plate_armor: {
    name: 'Coraza de Placas', type: 'Armadura', spriteId: 'armor', price: 150,
    req: { level: 2, fuerza: 20 }
  },
  gem_light: {
    name: 'Gema de Luz', type: 'Gema', spriteId: 'gem', price: 30, req: { level: 1 }
  },
  soul_sphere: {
    name: 'Esfera de Alma', type: 'Gema', spriteId: 'sphere', price: 45, req: { level: 1 }
  },
  chaos_stone: {
    name: 'Piedra del Caos', type: 'Gema', spriteId: 'chaos_stone', price: 120, req: { level: 1 }
  }
};

// Tipo de ítem -> ranura del paperdoll. Los tipos ausentes no son equipables.
const EQUIP_SLOT_BY_TYPE = {
  Casco: 'head',
  Armadura: 'chest',
  Arma: 'rightHand',
  Escudo: 'leftHand',
  Alas: 'back'
};

const CATALOG_BY_NAME = Object.fromEntries(
  Object.values(ITEM_CATALOG).map((item) => [item.name, item])
);

// --- Comerciante (Módulo E) --------------------------------------------------
// Un NPC fijo en el mapa. El servidor es la autoridad: valida distancia, oro y
// espacio antes de mover un solo dato.
// Solo la ciudad tiene comerciante: en el bosque no hay a quién vender.
const MERCHANT = {
  id: 'merchant_1',
  name: 'Comerciante',
  mapId: 1,
  x: 1750,
  y: 1600
};

const SHOP_RANGE = 50;   // Distancia máxima (px) para comerciar
const SHOP_BUY_MARGIN = 0.5; // El comerciante paga el 50% del costo base

// Lo que el comerciante vende, en el orden en que se muestra en el panel
const SHOP_STOCK_KEYS = ['potion_health', 'potion_mana', 'sword_iron', 'shield_oak'];

// Ítems tirados en el suelo, indexados por dropId
const worldDrops = {};

const DROP_DESPAWN_MS = 30000; // Los ítems desaparecen del suelo a los 30 segundos
const PICKUP_RANGE = 40;       // Distancia máxima (px) para recoger un ítem

// Progresión: la XP acumulada necesaria para subir de nivel es (nivel actual * 100)
const XP_POR_NIVEL = 100;
const STAT_POINTS_POR_NIVEL = 5;

// Reparto de puntos de estadística (Módulo D): cada punto sube 1 el atributo
// elegido, y la vitalidad / inteligencia arrastran sus valores derivados.
const HP_POR_VITALIDAD = 10;
const MP_POR_INTELIGENCIA = 8;
const ASSIGNABLE_ATTRIBUTES = ['fuerza', 'agilidad', 'inteligencia', 'vitalidad'];

// Cierre de sesión (Módulo F): en combate no se sale de inmediato, hay que
// aguantar una cuenta regresiva que cualquier movimiento o ataque cancela.
const LOGOUT_ACTIONS = ['select_character', 'exit'];
const COMBAT_LOGOUT_BLOCK_MS = 10000; // Ventana de "seguimos peleando" desde el último golpe
const LOGOUT_COUNTDOWN_SECONDS = 5;
const ATTRIBUTE_LABELS = {
  fuerza: 'Fuerza',
  agilidad: 'Agilidad',
  inteligencia: 'Inteligencia',
  vitalidad: 'Vitalidad'
};

// --- Habilidades de clase (Módulo G) -----------------------------------------
// Una habilidad por clase. El daño sale del atributo propio de cada una, así que
// subir de nivel y repartir puntos se nota al pelear.
const SKILLS = {
  Mago: {
    id: 'arcane_missile',
    name: 'Misil Arcano',
    kind: 'projectile',
    projectile: 'arcane',
    mpCost: 15,
    cooldownMs: 1200,
    speed: 320,
    range: 420,
    damage: (player) => player.inteligencia * 1.8
  },
  Cazador: {
    id: 'true_shot',
    name: 'Disparo Certero',
    kind: 'projectile',
    projectile: 'arrow',
    mpCost: 10,
    cooldownMs: 900,
    speed: 560,
    range: 520,
    damage: (player) => player.agilidad * 1.5
  },
  Guerrero: {
    id: 'vorpal_slash',
    name: 'Corte Vorpal',
    kind: 'arc',
    mpCost: 10,
    cooldownMs: 2500,
    range: 80,                    // Abanico de 80 px
    arcHalfAngle: Math.PI / 3,    // ...y 120º de apertura total
    critChance: 0.2,              // 20% de impacto crítico
    critMultiplier: 2,
    damage: (player) => player.fuerza * 1.8
  },
  Asesino: {
    id: 'shadow_strike',
    name: 'Ataque Sombrío',
    kind: 'blink',
    mpCost: 12,
    cooldownMs: 3000,
    blinkDistance: 100,           // Salto corto hacia el cursor
    hitRange: 60,                 // Alcance del golpe garantizado
    damage: (player) => player.agilidad * 1.4
  }
};

// Proyectiles vivos, indexados por id. Los simula el servidor: el cliente solo
// dibuja lo que se le cuenta.
const projectiles = {};

const PROJECTILE_TICK_MS = 50;  // La trayectoria se revisa 20 veces por segundo
const PROJECTILE_RADIUS = 20;   // Radio de colisión del proyectil

// Tamaño del mapa. Debe coincidir con los límites de la cámara del cliente:
// ambos son cuadrículas de 100 x 100 tiles de 32 px.
const WORLD_WIDTH = MAP_SIZE;
const WORLD_HEIGHT = MAP_SIZE;

// Regeneración pasiva: fuera de combate la vida y el maná vuelven solos
const REGEN_INTERVAL_MS = 3000;
const REGEN_HP_RATIO = 0.03;
const REGEN_MP_RATIO = 0.05;

// Derribo: todavía no hay sistema de muerte, así que caer a cero devuelve al
// personaje al punto de aparición de su zona (ver config/maps.js) con la vida y
// el maná al máximo.

// --- Karma y bando (Módulo H) ---
// El bando que se guarda en la base de datos solo tiene tres valores y se deriva
// del karma: caer por debajo de cero convierte en Renegado y pasar del umbral de
// héroe devuelve a Ciudadano. El brillo de héroe es el tramo alto del mismo bando.
const KARMA_CRIMINAL = 0;
const KARMA_HERO = 100;

// Cuánto mueve el karma cada acción de armas
const KARMA_HIT_CITIZEN = -2;    // golpear a un ciudadano sin ser renegado
const KARMA_DOWN_CITIZEN = -25;  // derribarlo
const KARMA_DOWN_NEUTRAL = -10;  // derribar a quien no tiene bando declarado
const KARMA_DOWN_RENEGADE = 15;  // dar caza a un renegado
const KARMA_MONSTER_KILL = 2;    // cazar monstruos redime

// Guarda experiencia, oro, nivel y puntos de estadística del personaje en PostgreSQL
async function persistCharacterProgress(player) {
  if (!player.characterId) return;

  try {
    await db.query(
      `UPDATE characters
          SET experience = $1, gold = $2, level = $3, stat_points = $4
        WHERE id = $5`,
      [player.experience, player.gold, player.level, player.statPoints, player.characterId]
    );
  } catch (error) {
    console.error(`⚠️ No se pudo guardar el progreso de ${player.name}:`, error.message);
  }
}

// Otorga XP y oro por la muerte de un monstruo, resuelve subidas de nivel y notifica al cliente
function grantCombatRewards(player, monster) {
  player.experience += monster.xp || 0;
  player.gold += monster.gold || 0;

  let leveledUp = false;
  while (player.experience >= player.level * XP_POR_NIVEL) {
    player.level += 1;
    player.statPoints += STAT_POINTS_POR_NIVEL;
    leveledUp = true;
  }

  persistCharacterProgress(player);

  // El XP y el oro cambian en cada muerte: el asesino tiene que verlo en su
  // panel aunque no llegue a subir de nivel
  const killerSocket = io.sockets.sockets.get(player.playerId);
  if (killerSocket) emitStats(killerSocket);

  if (leveledUp) {
    emitToMap(player.mapId, 'playerLeveledUp', {
      characterId: player.characterId,
      playerId: player.playerId,
      level: player.level,
      statPoints: player.statPoints
    });
  }
}

// El jugador está en combate desde este instante: bloquea el cierre de sesión
function markInCombat(player) {
  if (player) player.lastCombatTime = Date.now();
}

// Moverse o atacar durante la cuenta regresiva cancela el cierre de sesión
function cancelPendingLogout(player) {
  if (!player || !player.pendingLogout) return;

  clearTimeout(player.pendingLogout.timer);
  player.pendingLogout = null;
}

// Persiste el estado del personaje, lo saca de la sala y confirma el cierre al
// socket que lo pidió. El socket sigue abierto hasta que el cliente lo cierra:
// así alcanza a recibir el logoutSuccess.
async function finalizeLogout(socket, action) {
  const player = players[socket.id];
  if (!player) return;

  cancelPendingLogout(player);

  if (player.characterId) {
    try {
      await db.query(
        `UPDATE characters
            SET map_id = $1, pos_x = $2, pos_y = $3, hp_current = $4, mp_current = $5,
                experience = $6, gold = $7, stat_points = $8
          WHERE id = $9`,
        [
          player.mapId,
          Math.round(player.x), Math.round(player.y),
          player.hpCurrent, player.mpCurrent,
          player.experience, player.gold, player.statPoints,
          player.characterId
        ]
      );
    } catch (error) {
      console.error(`⚠️ No se pudo guardar la sesión de ${player.name}:`, error.message);
    }
  }

  delete players[socket.id];
  io.to(mapRoom(player.mapId)).emit('playerDisconnected', socket.id);
  socket.emit('logoutSuccess', { action });

  console.log(`👋 ${player.name} cerró sesión (${action})`);
}

// Crea o refresca los templates de ítems en PostgreSQL y cachea sus ids en memoria.
// Idempotente: se ejecuta una vez al arrancar el servidor.
async function ensureItemTemplates() {
  for (const item of Object.values(ITEM_CATALOG)) {
    const req = item.req || {};
    const reqLevel = req.level || 1;
    const reqFuerza = req.fuerza || 0;
    const reqAgilidad = req.agilidad || 0;
    const reqInteligencia = req.inteligencia || 0;

    const existing = await db.query(
      'SELECT id FROM item_templates WHERE name = $1 ORDER BY id LIMIT 1',
      [item.name]
    );

    if (existing.rows.length > 0) {
      // El catálogo manda: refresca el template existente para que los
      // requisitos del código y de la base de datos no se separen.
      const updated = await db.query(
        `UPDATE item_templates
            SET type = $2, sprite_id = $3, req_level = $4,
                req_fuerza = $5, req_agilidad = $6, req_inteligencia = $7
          WHERE id = $1
          RETURNING id`,
        [existing.rows[0].id, item.type, item.spriteId, reqLevel, reqFuerza, reqAgilidad, reqInteligencia]
      );
      item.templateId = updated.rows[0].id;
      continue;
    }

    const inserted = await db.query(
      `INSERT INTO item_templates
         (name, type, sprite_id, req_level, req_fuerza, req_agilidad, req_inteligencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [item.name, item.type, item.spriteId, reqLevel, reqFuerza, reqAgilidad, reqInteligencia]
    );
    item.templateId = inserted.rows[0].id;
  }

  console.log(`🎁 Catálogo de ítems listo (${Object.keys(ITEM_CATALOG).length} templates)`);
}

// Tira la tabla de botín del monstruo y devuelve la clave del ítem o null
function rollMonsterDrop(monster) {
  const table = monster.drops || [];

  for (const entry of table) {
    if (Math.random() < entry.chance) return entry.itemKey;
  }

  return null;
}

// Proyección pública de un drop (omite el temporizador interno)
function publicDrop(drop) {
  return {
    dropId: drop.dropId,
    name: drop.name,
    spriteId: drop.spriteId,
    x: drop.x,
    y: drop.y
  };
}

// Tira un ítem en las coordenadas del monstruo, arranca su despawn y lo anuncia
function spawnDrop(monster) {
  const itemKey = rollMonsterDrop(monster);
  if (!itemKey) return;

  const item = ITEM_CATALOG[itemKey];
  const dropId = randomUUID();

  const drop = {
    dropId,
    mapId: monster.mapId,
    itemKey,
    name: item.name,
    spriteId: item.spriteId,
    x: monster.x,
    y: monster.y,
    despawnTimer: setTimeout(() => {
      delete worldDrops[dropId];
      emitToMap(drop.mapId, 'itemDespawned', { dropId });
    }, DROP_DESPAWN_MS)
  };

  worldDrops[dropId] = drop;

  emitToMap(drop.mapId, 'itemDropped', publicDrop(drop));
}

// --- Combate por clases (Módulo G) -------------------------------------------

// La habilidad de la clase, o null si esa clase no tiene ninguna
function skillForClass(characterClass) {
  return SKILLS[characterClass] || null;
}

// Lo que el cliente necesita saber de su habilidad para ofrecerla en el HUD
function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    kind: skill.kind,
    mpCost: skill.mpCost,
    cooldownMs: skill.cooldownMs
  };
}

function skillDenied(socket, text) {
  socket.emit('skillDenied', { text });
}

// Daño de una habilidad, redondeado y nunca por debajo de 1: un atributo bajo no
// debe convertir la habilidad en un gesto inútil
function skillDamage(player, skill, critical) {
  const base = Math.max(1, Math.round(skill.damage(player)));

  return critical ? Math.round(base * (skill.critMultiplier || 1)) : base;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Ángulo normalizado a (-PI, PI], para comparar direcciones sin dar vueltas
function normalizeAngle(angle) {
  const turn = Math.PI * 2;

  return ((angle + Math.PI) % turn + turn) % turn - Math.PI;
}

// Aplica daño a un monstruo: barra, muerte, recompensas y reaparición. Devuelve
// true si el golpe lo tumbó.
function damageMonster(monster, damage, player, options = {}) {
  if (!monster || !monster.alive) return false;

  monster.hp = Math.max(0, monster.hp - damage);
  markInCombat(player);

  emitToMap(monster.mapId, 'monsterDamaged', {
    monsterId: monster.id,
    damage,
    currentHp: monster.hp,
    maxHp: monster.maxHp,
    critical: Boolean(options.critical),
    skillId: options.skillId || null
  });

  if (monster.hp > 0) return false;

  monster.alive = false;
  emitToMap(monster.mapId, 'monsterKilled', {
    monsterId: monster.id,
    killedBy: player ? player.name : 'un golpe perdido'
  });

  // Sin dueño (se desconectó a mitad de vuelo) no hay recompensas que dar
  if (player) {
    grantCombatRewards(player, monster);

    // Cazar monstruos redime: es la vía pacífica de recuperar el bando
    applyKarma(player, KARMA_MONSTER_KILL);
  }

  spawnDrop(monster);

  setTimeout(() => {
    monster.hp = monster.maxHp;
    monster.alive = true;
    emitToMap(monster.mapId, 'monsterRespawned', monster);
  }, 5000); // Reaparece a los 5 segundos

  return true;
}

// Guarda vida, maná y posición. El derribo no pasa por el cierre de sesión, que
// es quien escribe normalmente estas columnas.
async function persistVitals(player) {
  if (!player.characterId) return;

  try {
    await db.query(
      `UPDATE characters
          SET hp_current = $2, mp_current = $3, pos_x = $4, pos_y = $5
        WHERE id = $1`,
      [
        player.characterId,
        Math.round(player.hpCurrent),
        Math.round(player.mpCurrent),
        Math.round(player.x),
        Math.round(player.y)
      ]
    );
  } catch (error) {
    console.error(`⚠️ No se pudo guardar la vida de ${player.name}:`, error.message);
  }
}

// Aplica daño a otro jugador. No hay equipos todavía: cualquier otro jugador es
// un objetivo válido, así que el PvP es de todos contra todos.
function damagePlayer(target, damage, attacker, options = {}) {
  if (!target) return false;

  target.hpCurrent = Math.max(0, target.hpCurrent - damage);
  markInCombat(target);

  emitToMap(target.mapId, 'playerDamaged', {
    playerId: target.playerId,
    characterId: target.characterId,
    damage,
    hpCurrent: target.hpCurrent,
    hpMax: target.hpMax,
    attackerId: attacker ? attacker.playerId : null,
    skillId: options.skillId || null
  });

  // Golpear a un ciudadano sin ser renegado mancha el karma; un renegado ya no
  // tiene nada que perder
  if (attacker && target.faction === 'Ciudadano' && attacker.faction !== 'Renegado') {
    applyKarma(attacker, KARMA_HIT_CITIZEN);
  }

  const targetSocket = io.sockets.sockets.get(target.playerId);
  if (targetSocket) emitStats(targetSocket);

  if (target.hpCurrent > 0) return false;

  // Derribar también mueve el karma, según el bando de la víctima
  if (attacker) applyKarma(attacker, karmaForDown(target));

  // Derribado: vuelve al punto de aparición de SU mapa con la vida y el maná
  // enteros. Con zonas separadas, resucitar en el mapa de al lado sería un viaje
  // gratis.
  const respawn = mapById(target.mapId).spawn;

  target.hpCurrent = target.hpMax;
  target.mpCurrent = target.mpMax;
  target.x = respawn.x;
  target.y = respawn.y;

  emitToMap(target.mapId, 'playerRespawned', {
    playerId: target.playerId,
    characterId: target.characterId,
    x: target.x,
    y: target.y,
    hpCurrent: target.hpCurrent,
    hpMax: target.hpMax,
    mpCurrent: target.mpCurrent,
    mpMax: target.mpMax
  });

  if (targetSocket) {
    emitStats(targetSocket);
    notify(targetSocket, 'Te han derribado: vuelves al punto de aparición de la zona.', '#ff5252');
  }

  persistVitals(target);

  return true;
}

// Crea un proyectil hacia el punto apuntado. La dirección se normaliza aquí: la
// trayectoria no depende de lo que el cliente cuente después.
function spawnProjectile(player, skill, targetX, targetY) {
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const distance = Math.hypot(dx, dy);

  // Apuntarse a los pies no tiene dirección: no se lanza nada
  if (distance < 1) return null;

  const id = randomUUID();

  projectiles[id] = {
    id,
    mapId: player.mapId,
    skillId: skill.id,
    kind: skill.projectile,
    ownerId: player.playerId,
    damage: skillDamage(player, skill, false),
    x: player.x,
    y: player.y,
    dirX: dx / distance,
    dirY: dy / distance,
    speed: skill.speed,
    // Vuela hasta donde apuntó el jugador, sin pasar del alcance de la habilidad
    remaining: Math.min(distance, skill.range)
  };

  emitToMap(player.mapId, 'projectileSpawned', {
    id,
    skillId: skill.id,
    kind: skill.projectile,
    ownerId: player.playerId,
    x: player.x,
    y: player.y,
    dirX: projectiles[id].dirX,
    dirY: projectiles[id].dirY,
    speed: skill.speed,
    remaining: projectiles[id].remaining
  });

  return projectiles[id];
}

// Primer monstruo vivo dentro del radio de colisión del proyectil y de su misma
// zona: un proyectil no cruza un portal
function projectileMonsterHit(projectile) {
  return Object.values(monsters).find((monster) => (
    monster.mapId === projectile.mapId
      && monster.alive
      && Math.hypot(projectile.x - monster.x, projectile.y - monster.y) <= PROJECTILE_RADIUS
  )) || null;
}

// Primer jugador dentro del radio que no sea el dueño del proyectil
function projectilePlayerHit(projectile) {
  return Object.values(players).find((player) => (
    player.mapId === projectile.mapId
      && player.playerId !== projectile.ownerId
      && Math.hypot(projectile.x - player.x, projectile.y - player.y) <= PROJECTILE_RADIUS
  )) || null;
}

// Avanza todos los proyectiles vivos y resuelve sus impactos
function tickProjectiles() {
  const seconds = PROJECTILE_TICK_MS / 1000;

  Object.keys(projectiles).forEach((id) => {
    const projectile = projectiles[id];
    if (!projectile) return;

    const step = Math.min(projectile.speed * seconds, projectile.remaining);
    projectile.x += projectile.dirX * step;
    projectile.y += projectile.dirY * step;
    projectile.remaining -= step;

    const monster = projectileMonsterHit(projectile);
    const target = monster || projectilePlayerHit(projectile);

    if (target) {
      delete projectiles[id];

      // El dueño puede haberse ido mientras el proyectil volaba
      const owner = players[projectile.ownerId] || null;

      if (monster) {
        damageMonster(monster, projectile.damage, owner, { skillId: projectile.skillId });
      } else {
        damagePlayer(target, projectile.damage, owner, { skillId: projectile.skillId });
      }

      emitToMap(projectile.mapId, 'projectileHit', {
        id,
        kind: projectile.kind,
        x: projectile.x,
        y: projectile.y,
        hit: true,
        damage: projectile.damage,
        targetId: monster ? monster.id : target.playerId,
        targetType: monster ? 'monster' : 'player'
      });
      return;
    }

    // Se acabó el recorrido sin tocar nada
    if (projectile.remaining <= 0) {
      delete projectiles[id];

      emitToMap(projectile.mapId, 'projectileHit', {
        id,
        kind: projectile.kind,
        x: projectile.x,
        y: projectile.y,
        hit: false,
        damage: 0,
        targetId: null,
        targetType: null
      });
      return;
    }

    emitToMap(projectile.mapId, 'projectileMoved', { id, x: projectile.x, y: projectile.y });
  });
}

// Corte Vorpal: barrido en abanico hacia donde se apunta, con crítico posible
function castArc(player, skill, targetX, targetY) {
  const aim = Math.atan2(targetY - player.y, targetX - player.x);
  const hits = [];

  monstersInMap(player.mapId).forEach((monster) => {
    if (!monster.alive) return;

    const distance = Math.hypot(monster.x - player.x, monster.y - player.y);
    if (distance > skill.range) return;

    // Fuera del abanico apuntado no lo alcanza, aunque esté cerca
    const angle = Math.atan2(monster.y - player.y, monster.x - player.x);
    if (Math.abs(normalizeAngle(angle - aim)) > skill.arcHalfAngle) return;

    const critical = Math.random() < skill.critChance;
    hits.push({ monster, damage: skillDamage(player, skill, critical), critical });
  });

  emitToMap(player.mapId, 'skillArc', {
    playerId: player.playerId,
    skillId: skill.id,
    x: player.x,
    y: player.y,
    angle: aim,
    range: skill.range
  });

  hits.forEach((entry) => {
    damageMonster(entry.monster, entry.damage, player, {
      critical: entry.critical,
      skillId: skill.id
    });
  });
}

// Primer monstruo vivo al alcance: el apuntado si sigue cerca, si no el más próximo
function meleeTarget(player, range, targetEntityId) {
  const close = monstersInMap(player.mapId).filter((monster) => (
    monster.alive && Math.hypot(monster.x - player.x, monster.y - player.y) <= range
  ));

  if (targetEntityId) {
    const aimed = close.find((monster) => monster.id === targetEntityId);
    if (aimed) return aimed;
  }

  return close.sort((a, b) => (
    Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y)
  ))[0] || null;
}

// Ataque Sombrío: salto corto hacia el cursor y golpe garantizado
function castBlink(player, skill, targetX, targetY, targetEntityId) {
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const distance = Math.hypot(dx, dy) || 1;
  const jump = Math.min(distance, skill.blinkDistance);

  const fromX = player.x;
  const fromY = player.y;

  player.x = clamp(player.x + (dx / distance) * jump, 0, WORLD_WIDTH);
  player.y = clamp(player.y + (dy / distance) * jump, 0, WORLD_HEIGHT);

  emitToMap(player.mapId, 'skillBlink', {
    playerId: player.playerId,
    skillId: skill.id,
    fromX,
    fromY,
    x: player.x,
    y: player.y
  });

  const target = meleeTarget(player, skill.hitRange, targetEntityId);
  if (target) {
    damageMonster(target, skillDamage(player, skill, false), player, { skillId: skill.id });
  }
}

// Vida y maná vuelven poco a poco cuando el jugador lleva un rato sin pelear
function regeneratePlayers() {
  const now = Date.now();

  Object.values(players).forEach((player) => {
    // "En combate" es la misma ventana que bloquea el cierre de sesión
    if (now - player.lastCombatTime < COMBAT_LOGOUT_BLOCK_MS) return;

    const hpGain = Math.max(0, Math.min(
      player.hpMax - player.hpCurrent,
      Math.round(player.hpMax * REGEN_HP_RATIO)
    ));
    const mpGain = Math.max(0, Math.min(
      player.mpMax - player.mpCurrent,
      Math.round(player.mpMax * REGEN_MP_RATIO)
    ));

    if (hpGain <= 0 && mpGain <= 0) return;

    player.hpCurrent += hpGain;
    player.mpCurrent += mpGain;

    const socket = io.sockets.sockets.get(player.playerId);
    if (socket) emitStats(socket);
  });
}

// --- Karma y bando (Módulo H) ------------------------------------------------

// Bando que le corresponde a un karma
function factionForKarma(karma) {
  if (karma < KARMA_CRIMINAL) return 'Renegado';
  if (karma > KARMA_CRIMINAL) return 'Ciudadano';

  return 'Neutral';
}

// Un héroe es un ciudadano con el karma muy alto: el bando guardado no cambia,
// pero el nombre se pinta en dorado
function isHero(player) {
  return Boolean(player) && player.karma > KARMA_HERO;
}

// Estado de bando que viaja a los clientes para pintar el nombre
function publicFaction(player) {
  return {
    playerId: player.playerId,
    characterId: player.characterId,
    faction: player.faction,
    karma: player.karma,
    hero: isHero(player)
  };
}

// Aviso privado a un jugador, esté donde esté su socket
function notifyPlayer(player, text, color = '#ffeb3b') {
  if (!player) return;

  const socket = io.sockets.sockets.get(player.playerId);
  if (socket) notify(socket, text, color);
}

// Persiste karma y bando: es el único sitio donde se escriben esas columnas
async function persistKarma(player) {
  if (!player || !player.characterId) return;

  try {
    await db.query(
      'UPDATE characters SET karma = $1, faction = $2 WHERE id = $3',
      [player.karma, player.faction, player.characterId]
    );
  } catch (error) {
    console.error(`⚠️ No se pudo guardar el karma de ${player.name}:`, error.message);
  }
}

// Mueve el karma y, si el bando cambia, lo anuncia a todos para que los nombres
// se repinten al instante
function applyKarma(player, delta) {
  if (!player || !delta) return;

  player.karma += delta;

  const previous = player.faction;
  player.faction = factionForKarma(player.karma);

  persistKarma(player);
  emitToMap(player.mapId, 'playerFactionUpdated', publicFaction(player));

  // El panel del personaje muestra el karma: hay que refrescarlo también
  const socket = io.sockets.sockets.get(player.playerId);
  if (socket) emitStats(socket);

  if (player.faction !== previous) {
    const criminal = player.faction === 'Renegado';

    notifyPlayer(
      player,
      criminal
        ? 'Tu karma ha caído por debajo de cero: ahora eres un RENEGADO.'
        : `Tu bando ha cambiado a ${player.faction}.`,
      criminal ? '#ff5252' : '#ffd700'
    );
  }
}

// Karma que mueve derribar a alguien, según el bando de la víctima
function karmaForDown(victim) {
  if (!victim) return 0;
  if (victim.faction === 'Renegado') return KARMA_DOWN_RENEGADE;
  if (victim.faction === 'Ciudadano') return KARMA_DOWN_CITIZEN;

  return KARMA_DOWN_NEUTRAL;
}

// Estado del personaje que decide el servidor. El cliente elige la ficha, pero no
// su karma, su bando, su clan ni el mapa donde estaba: eso lo manda la base de
// datos.
async function loadCharacterState(characterId) {
  if (!characterId) return null;

  try {
    const result = await db.query(
      `SELECT c.karma, c.faction, c.clan_id, c.clan_rank, c.map_id, cl.name AS clan_name
         FROM characters c
         LEFT JOIN clans cl ON cl.id = c.clan_id
        WHERE c.id = $1`,
      [characterId]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.error('⚠️ No se pudo leer el estado del personaje:', error.message);
    return null;
  }
}

// --- Clanes (Módulo H) -------------------------------------------------------

// Avisa a todo el mundo de que la etiqueta de clan de un jugador cambió: el mapa
// la borra o la repinta al instante
function broadcastPlayerClan(player) {
  emitToMap(player.mapId, 'playerClanUpdated', {
    playerId: player.playerId,
    characterId: player.characterId,
    clanName: player.clanName || null,
    clanRank: player.clanRank || null
  });
}

// Ficha del clan de un jugador, marcando quién está en línea ahora mismo
async function clanStateFor(player) {
  const state = await clanController.getClanState({
    clanId: player.clanId,
    characterId: player.characterId
  });

  if (!state.clan) return { clan: null, members: [] };

  const online = new Set(Object.values(players).map((p) => p.characterId));

  return {
    clan: state.clan,
    members: state.members.map((member) => ({ ...member, online: online.has(member.characterId) }))
  };
}

// Deja el registro en memoria a tono con la base de datos y avisa a los clientes
async function syncPlayerClan(player) {
  const stored = await loadCharacterState(player.characterId);

  player.clanId = (stored && stored.clan_id) || null;
  player.clanName = (stored && stored.clan_name) || null;
  player.clanRank = (stored && stored.clan_rank) || null;

  broadcastPlayerClan(player);

  const socket = io.sockets.sockets.get(player.playerId);
  if (socket) socket.emit('clanInfo', await clanStateFor(player));
}

// Refresca la ventana de clan de todos los miembros conectados
async function refreshClanMembers(clanId) {
  if (!clanId) return;

  const connected = Object.values(players).filter((p) => p.clanId === clanId);

  await Promise.all(connected.map(async (member) => {
    const socket = io.sockets.sockets.get(member.playerId);
    if (!socket) return;

    socket.emit('clanInfo', await clanStateFor(member));
  }));
}

// --- Inventario -------------------------------------------------------------

const INVENTORY_QUERY = `
  SELECT i.id, i.item_template_id, i.slot_index, i.is_equipped, i.enhance_level, i.bonus_attributes,
         t.name, t.type, t.sprite_id, t.req_level, t.req_fuerza, t.req_agilidad, t.req_inteligencia,
         t.base_damage_min, t.base_damage_max, t.base_defense
    FROM inventory_items i
    JOIN item_templates t ON t.id = i.item_template_id
   WHERE i.character_id = $1
   ORDER BY i.slot_index NULLS LAST, i.enhance_level DESC`;

// Normaliza una fila de la base de datos al formato que consume el cliente
function serializeInventoryItem(row) {
  const catalogItem = CATALOG_BY_NAME[row.name];

  return {
    id: row.id,
    templateId: row.item_template_id,
    slotIndex: row.slot_index,
    isEquipped: row.is_equipped,
    enhanceLevel: row.enhance_level,
    bonusAttributes: row.bonus_attributes,
    name: row.name,
    type: row.type,
    spriteId: row.sprite_id,
    equipSlot: EQUIP_SLOT_BY_TYPE[row.type] || null,
    effect: (catalogItem && catalogItem.effect) || null,
    // Lo que el comerciante pagaría por este ítem (Módulo E)
    salePrice: catalogItem ? salePrice(catalogItem) : 0,
    requirements: {
      level: row.req_level,
      fuerza: row.req_fuerza,
      agilidad: row.req_agilidad,
      inteligencia: row.req_inteligencia
    },
    stats: {
      damageMin: row.base_damage_min,
      damageMax: row.base_damage_max,
      defense: row.base_defense
    }
  };
}

// Envía al dueño del socket su inventario completo
async function emitInventory(socket, eventName = 'inventoryUpdated') {
  const player = players[socket.id];
  if (!player || !player.characterId) return;

  try {
    const result = await db.query(INVENTORY_QUERY, [player.characterId]);
    socket.emit(eventName, result.rows.map(serializeInventoryItem));
  } catch (error) {
    console.error(`⚠️ No se pudo cargar el inventario de ${player.name}:`, error.message);
  }
}

// Envía al dueño del socket sus estadísticas actuales
function emitStats(socket) {
  const player = players[socket.id];
  if (!player) return;

  socket.emit('playerStatsUpdated', {
    level: player.level,
    experience: player.experience,
    gold: player.gold,
    statPoints: player.statPoints,
    fuerza: player.fuerza,
    agilidad: player.agilidad,
    inteligencia: player.inteligencia,
    vitalidad: player.vitalidad,
    karma: player.karma,
    faction: player.faction,
    hpCurrent: player.hpCurrent,
    hpMax: player.hpMax,
    mpCurrent: player.mpCurrent,
    mpMax: player.mpMax
  });
}

// Mensaje de sistema al jugador (reutiliza el log de chat existente)
function notify(socket, text, color = '#ffeb3b') {
  socket.emit('chatMessage', { sender: 'SISTEMA', text, color });
}

// Proyección pública de un NPC
function publicNpc(npc) {
  return { id: npc.id, name: npc.name, x: npc.x, y: npc.y };
}

// Proyección pública de un jugador. Nunca se manda la ficha interna: dentro vive
// el temporizador del cierre de sesión, que además no es serializable.
function publicPlayer(player) {
  return {
    playerId: player.playerId,
    characterId: player.characterId,
    name: player.name,
    characterClass: player.characterClass,
    level: player.level,
    faction: player.faction,
    karma: player.karma,
    hero: isHero(player),
    clanName: player.clanName || null,
    clanRank: player.clanRank || null,
    x: player.x,
    y: player.y
  };
}

// Precio al que el comerciante compra: la mitad del costo base, redondeado a
// la baja para que el jugador nunca gane oro comprando y vendiendo.
function salePrice(item) {
  return Math.floor((item.price || 0) * SHOP_BUY_MARGIN);
}

// Escaparate del comerciante tal como lo consume el cliente (ids ya resueltos
// por ensureItemTemplates)
function publicShopCatalog() {
  return SHOP_STOCK_KEYS.map((key) => {
    const item = ITEM_CATALOG[key];
    const req = item.req || {};

    return {
      templateId: item.templateId,
      name: item.name,
      spriteId: item.spriteId,
      type: item.type,
      price: item.price,
      requirements: {
        level: req.level || 1,
        fuerza: req.fuerza || 0,
        agilidad: req.agilidad || 0,
        inteligencia: req.inteligencia || 0
      }
    };
  });
}

// Solo se puede comprar lo que el comerciante tiene en el escaparate
function findStockItem(templateId) {
  return SHOP_STOCK_KEYS
    .map((key) => ITEM_CATALOG[key])
    .find((item) => item.templateId === templateId) || null;
}

// El comercio exige estar junto al NPC y en su misma zona; el cliente solo
// sugiere la intención
function isNearMerchant(player) {
  if (player.mapId !== MERCHANT.mapId) return false;

  return Math.hypot(player.x - MERCHANT.x, player.y - MERCHANT.y) <= SHOP_RANGE;
}

// NPCs de una zona. Hoy solo la ciudad tiene comerciante.
function npcsInMap(mapId) {
  return MERCHANT.mapId === mapId ? [MERCHANT] : [];
}

// Resultado de una compra o venta: el panel de tienda lo muestra como
// confirmación y el chat lo registra como historial
function shopResult(socket, ok, text) {
  socket.emit('shopResult', { ok, text });
}

// Devuelve la lista de requisitos incumplidos por el jugador
function unmetRequirements(player, item) {
  const missing = [];

  if (player.level < item.req_level) missing.push(`Nivel ${item.req_level}`);
  if (player.fuerza < item.req_fuerza) missing.push(`Fuerza ${item.req_fuerza}`);
  if (player.agilidad < item.req_agilidad) missing.push(`Agilidad ${item.req_agilidad}`);
  if (player.inteligencia < item.req_inteligencia) missing.push(`Inteligencia ${item.req_inteligencia}`);

  return missing;
}

// Carga un ítem del inventario del personaje junto con los datos de su template
async function loadInventoryItem(client, itemId, characterId) {
  const result = await client.query(
    `SELECT i.id, i.slot_index, i.is_equipped, i.enhance_level,
            t.name, t.type, t.req_level, t.req_fuerza, t.req_agilidad, t.req_inteligencia
       FROM inventory_items i
       JOIN item_templates t ON t.id = i.item_template_id
      WHERE i.id = $1 AND i.character_id = $2`,
    [itemId, characterId]
  );

  return result.rows[0] || null;
}

// Primer casillero libre de la mochila (0-29). Los ítems equipados tienen
// slot_index NULL y por lo tanto nunca bloquean un casillero.
async function findFreeSlot(client, characterId) {
  const result = await client.query(
    `SELECT slot
       FROM generate_series(0, 29) AS slot
      WHERE NOT EXISTS (
            SELECT 1 FROM inventory_items i
             WHERE i.character_id = $1 AND i.slot_index = slot
      )
      ORDER BY slot
      LIMIT 1`,
    [characterId]
  );

  return result.rows.length > 0 ? result.rows[0].slot : null;
}

io.on('connection', async (socket) => {
  const char = socket.character || {};
  console.log(`🎮 Personaje conectado: ${char.name || socket.id}`);

  // El karma y el bando son estado de juego: los decide el servidor y se leen de
  // la base de datos, no de lo que cuente el cliente en el handshake.
  const stored = await loadCharacterState(char.id);

  // El mapa lo decide el servidor: la ficha de la base de datos manda sobre lo
  // que el cliente haya mandado en el handshake.
  const mapId = Number(stored && stored.map_id) || DEFAULT_MAP_ID;
  const arrival = mapById(mapId).spawn;

  // La posición se guarda al cerrar sesión (Módulo F): al volver, el personaje
  // aparece donde quedó. Una posición que no sea un número, o que caiga fuera
  // del tablero, no puede dejar al personaje en el vacío: cae al punto de
  // aparición de su zona.
  const storedX = Number(char.pos_x);
  const storedY = Number(char.pos_y);
  const spawnX = Number.isFinite(storedX) ? clampToMap(storedX) : arrival.x;
  const spawnY = Number.isFinite(storedY) ? clampToMap(storedY) : arrival.y;

  players[socket.id] = {
    playerId: socket.id,
    userId: socket.user.userId,
    characterId: char.id || null,
    mapId,
    name: char.name || 'Aventurero',
    characterClass: char.character_class || 'Guerrero',
    level: char.level || 1,
    experience: Number(char.experience) || 0,
    gold: Number(char.gold) || 0,
    statPoints: Number(char.stat_points) || 0,
    fuerza: Number(char.fuerza) || 0,
    agilidad: Number(char.agilidad) || 0,
    inteligencia: Number(char.inteligencia) || 0,
    vitalidad: Number(char.vitalidad) || 0,
    hpCurrent: Number(char.hp_current) || 0,
    hpMax: Number(char.hp_max) || 0,
    mpCurrent: Number(char.mp_current) || 0,
    mpMax: Number(char.mp_max) || 0,
    x: spawnX,
    y: spawnY,
    karma: stored ? Number(stored.karma) || 0 : 0,
    faction: (stored && stored.faction) || 'Neutral',
    clanId: (stored && stored.clan_id) || null,
    clanName: (stored && stored.clan_name) || null,
    clanRank: (stored && stored.clan_rank) || null,
    lastCombatTime: 0,   // 0 = nunca ha combatido en esta sesión
    pendingLogout: null, // cuenta regresiva de cierre de sesión en curso
    skillReadyAt: 0      // momento (ms) en que la habilidad vuelve a estar lista
  };

  // Enviar estado inicial al jugador entrante. La sala se une ANTES de mandar
  // nada: a partir de aquí todo lo que se emita a map_<id> ya le llega.
  socket.join(mapRoom(mapId));

  socket.emit('mapInfo', publicMap(mapId));

  // Solo se cuentan los jugadores, los monstruos, el botín y los NPCs de su
  // zona: el censo de otro mapa no le importa a nadie.
  socket.emit('currentPlayers', playersSnapshot(mapId));
  socket.emit('currentMonsters', Object.fromEntries(
    monstersInMap(mapId).map((monster) => [monster.id, monster])
  ));
  socket.emit('currentDrops', Object.values(worldDrops)
    .filter((drop) => drop.mapId === mapId)
    .map(publicDrop));
  socket.emit('currentNpcs', npcsInMap(mapId).map(publicNpc));
  socket.emit('shopCatalog', publicShopCatalog());

  // Los jugadores viajan proyectados: la ficha interna guarda un temporizador que
  // JSON no puede serializar.
  socket.to(mapRoom(mapId)).emit('newPlayer', publicPlayer(players[socket.id]));

  // Inventario y estadísticas del personaje
  emitInventory(socket, 'currentInventory');
  emitStats(socket);

  // Clanes (Módulo H): la ficha del clan y las invitaciones que quedaron pendientes
  socket.emit('clanInfo', await clanStateFor(players[socket.id]));

  const invited = await clanController.pendingInvites(players[socket.id].characterId);
  invited.forEach((invite) => {
    socket.emit('clanInviteReceived', {
      clanId: invite.clanId,
      clanName: invite.clanName,
      from: null
    });
  });

  // Qué habilidad tiene esta clase y cuánto cuesta lanzarla
  const classSkill = skillForClass(players[socket.id].characterClass);
  if (classSkill) {
    socket.emit('skillInfo', publicSkill(classSkill));
    notify(
      socket,
      `${classSkill.name}: cuesta ${classSkill.mpCost} de maná y se lanza con el clic derecho.`,
      '#7fd4ff'
    );
  }

  // Movimiento
  socket.on('playerMovement', (movementData) => {
    const player = players[socket.id];
    if (!player) return;

    // Moverse cancela un cierre de sesión en curso
    cancelPendingLogout(player);

    // El cliente no es autoridad sobre la posición: se acota al tablero, así una
    // cifra absurda no saca al personaje del mundo ni lo deja en NaN.
    const nextX = Number(movementData.x);
    const nextY = Number(movementData.y);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;

    player.x = clampToMap(nextX);
    player.y = clampToMap(nextY);

    // Solo lo ve quien comparte zona: la sala se encarga del filtro
    socket.to(mapRoom(player.mapId)).emit('playerMoved', publicPlayer(player));
  });

  // Combate (Ataque con Espacio)
  socket.on('playerAttack', () => {
    const player = players[socket.id];
    if (!player) return;

    // Atacar cancela un cierre de sesión en curso, aunque no acierte
    cancelPendingLogout(player);

    // Buscar monstruos vivos dentro del rango de ataque melee (60px) y de la
    // misma zona: el golpe no cruza portales
    monstersInMap(player.mapId).forEach((m) => {
      if (!m.alive) return;
      if (Math.hypot(player.x - m.x, player.y - m.y) > 60) return;

      // Daño entre 10 y 25. El golpe básico no depende del atributo: el daño por
      // atributo es lo que distingue a las habilidades de cada clase.
      damageMonster(m, Math.floor(Math.random() * 15) + 10, player);
    });
  });

  // Habilidad de clase (Módulo G). El servidor valida recarga, maná y dirección
  // antes de gastar un solo punto: el cliente solo apunta.
  socket.on('castSkill', (payload) => {
    const player = players[socket.id];
    if (!player) return;

    const skill = skillForClass(player.characterClass);
    if (!skill) {
      skillDenied(socket, 'Tu clase no tiene habilidades.');
      return;
    }

    // Si el cliente nombra una habilidad, tiene que ser la suya
    const requested = payload && payload.skillId;
    if (requested && requested !== skill.id) return;

    const targetX = Number(payload && payload.targetX);
    const targetY = Number(payload && payload.targetY);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;

    // Lanzar una habilidad cancela un cierre de sesión en curso
    cancelPendingLogout(player);

    const now = Date.now();
    if (player.skillReadyAt > now) {
      const pending = ((player.skillReadyAt - now) / 1000).toFixed(1);
      skillDenied(socket, `${skill.name} se está recargando (${pending}s).`);
      return;
    }

    if (player.mpCurrent < skill.mpCost) {
      skillDenied(socket, `Te falta maná: ${skill.name} cuesta ${skill.mpCost}.`);
      return;
    }

    // El apuntado se acota al mapa: el cliente no decide hasta dónde llega
    const aimX = clamp(targetX, 0, WORLD_WIDTH);
    const aimY = clamp(targetY, 0, WORLD_HEIGHT);

    // Apuntarse a los pies no gasta maná ni arranca la recarga
    if (skill.kind === 'projectile' && Math.hypot(aimX - player.x, aimY - player.y) < 1) {
      skillDenied(socket, 'Apunta a algún sitio para lanzar el proyectil.');
      return;
    }

    player.mpCurrent -= skill.mpCost;
    player.skillReadyAt = now + skill.cooldownMs;

    // Lanzar la habilidad es pelear: cuenta para el cierre de sesión y para la
    // regeneración igual que un golpe
    markInCombat(player);
    emitStats(socket);

    if (skill.kind === 'projectile') {
      spawnProjectile(player, skill, aimX, aimY);
    } else if (skill.kind === 'arc') {
      castArc(player, skill, aimX, aimY);
    } else {
      castBlink(player, skill, aimX, aimY, payload && payload.targetEntityId);
    }
  });

  // Recoger un ítem del suelo (tecla G en el cliente)
  socket.on('pickUpItem', async (payload) => {
    const dropId = payload && payload.dropId;
    const player = players[socket.id];
    if (!player || !dropId) return;

    const drop = worldDrops[dropId];
    if (!drop) return;

    // El botín vive en una zona: no se puede recoger el de otro mapa ni de lejos
    if (drop.mapId !== player.mapId) return;

    // Validación de rango en el servidor (el cliente solo sugiere)
    const distance = Math.hypot(player.x - drop.x, player.y - drop.y);
    if (distance > PICKUP_RANGE) return;

    const item = ITEM_CATALOG[drop.itemKey];
    if (!player.characterId || !item || !item.templateId) return;

    try {
      // Un solo statement: ocupa el primer slot_index libre (0-29) del inventario
      const result = await db.query(
        `INSERT INTO inventory_items (character_id, item_template_id, slot_index)
         SELECT $1, $2, slot
           FROM generate_series(0, 29) AS slot
          WHERE NOT EXISTS (
                SELECT 1 FROM inventory_items i
                 WHERE i.character_id = $1 AND i.slot_index = slot
          )
          ORDER BY slot
          LIMIT 1
         RETURNING slot_index`,
        [player.characterId, item.templateId]
      );

      if (result.rowCount === 0) {
        socket.emit('chatMessage', {
          sender: 'SISTEMA',
          text: 'Tu inventario está lleno.',
          color: '#ff5252'
        });
        return;
      }
    } catch (error) {
      console.error(`⚠️ No se pudo guardar ${item.name} para ${player.name}:`, error.message);
      return;
    }

    clearTimeout(drop.despawnTimer);
    delete worldDrops[dropId];
    emitToMap(player.mapId, 'itemPickedUp', { dropId });
  });

  // Consumir una poción (clic en el inventario)
  socket.on('useItem', async (payload) => {
    const itemId = payload && payload.itemId;
    const player = players[socket.id];
    if (!player || !player.characterId || !itemId) return;

    try {
      const result = await db.query(
        `SELECT i.id, i.is_equipped, t.name
           FROM inventory_items i
           JOIN item_templates t ON t.id = i.item_template_id
          WHERE i.id = $1 AND i.character_id = $2`,
        [itemId, player.characterId]
      );

      const item = result.rows[0];
      if (!item || item.is_equipped) return;

      const catalogItem = CATALOG_BY_NAME[item.name];
      const effect = catalogItem && catalogItem.effect;
      if (!effect) {
        notify(socket, `${item.name} no es consumible.`, '#ff5252');
        return;
      }

      const isHp = effect.stat === 'hp';
      const current = isHp ? player.hpCurrent : player.mpCurrent;
      const max = isHp ? player.hpMax : player.mpMax;

      if (current >= max) {
        notify(socket, isHp ? 'Tu vida ya está al máximo.' : 'Tu maná ya está al máximo.', '#ff5252');
        return;
      }

      // Nunca se excede hp_max / mp_max
      const restored = Math.min(max, current + effect.amount) - current;
      const nextHp = isHp ? current + restored : player.hpCurrent;
      const nextMp = isHp ? player.mpCurrent : current + restored;

      // Persistir antes de tocar la memoria: si falla la base de datos no hay divergencia
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE characters SET hp_current = $2, mp_current = $3 WHERE id = $1',
          [player.characterId, nextHp, nextMp]
        );
        await client.query(
          'DELETE FROM inventory_items WHERE id = $1 AND character_id = $2',
          [itemId, player.characterId]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      player.hpCurrent = nextHp;
      player.mpCurrent = nextMp;

      notify(socket, `Usas ${item.name} y recuperas ${restored} ${isHp ? 'HP' : 'MP'}.`, '#a5d6a7');
      emitInventory(socket);
      emitStats(socket);
    } catch (error) {
      console.error(`⚠️ Error al usar un ítem de ${player.name}:`, error.message);
    }
  });

  // Equipar un ítem de la mochila (clic en el inventario)
  socket.on('equipItem', async (payload) => {
    const itemId = payload && payload.itemId;
    const player = players[socket.id];
    if (!player || !player.characterId || !itemId) return;

    const client = await db.pool.connect();
    let failure = null;
    let equippedName = null;

    try {
      await client.query('BEGIN');

      const item = await loadInventoryItem(client, itemId, player.characterId);
      if (!item || item.is_equipped) {
        await client.query('ROLLBACK');
        return;
      }

      if (!EQUIP_SLOT_BY_TYPE[item.type]) {
        await client.query('ROLLBACK');
        notify(socket, `${item.name} no se puede equipar.`, '#ff5252');
        return;
      }

      const missing = unmetRequirements(player, item);
      if (missing.length > 0) {
        await client.query('ROLLBACK');
        notify(socket, `No cumples los requisitos de ${item.name}: ${missing.join(', ')}.`, '#ff5252');
        return;
      }

      equippedName = item.name;
      const freedSlot = item.slot_index;

      // 1. El ítem nuevo pasa al paperdoll y libera su casillero de mochila
      await client.query(
        'UPDATE inventory_items SET is_equipped = TRUE, slot_index = NULL WHERE id = $1',
        [itemId]
      );

      // 2. Si esa ranura ya tenía un ítem equipado, vuelve al casillero liberado
      await client.query(
        `UPDATE inventory_items
            SET is_equipped = FALSE, slot_index = $2
          WHERE id = (
                SELECT i.id
                  FROM inventory_items i
                  JOIN item_templates t ON t.id = i.item_template_id
                 WHERE i.character_id = $1
                   AND i.is_equipped = TRUE
                   AND i.id <> $3
                   AND t.type = $4
                 LIMIT 1
          )`,
        [player.characterId, freedSlot, itemId, item.type]
      );

      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ya revertida */ }
      failure = error;
    } finally {
      client.release();
    }

    if (failure) {
      console.error(`⚠️ Error al equipar en ${player.name}:`, failure.message);
      notify(socket, 'No se pudo equipar el ítem.', '#ff5252');
      return;
    }

    notify(socket, `Equipas ${equippedName}.`, '#a5d6a7');
    emitInventory(socket);
  });

  // Desequipar un ítem del paperdoll (clic en el inventario)
  socket.on('unequipItem', async (payload) => {
    const itemId = payload && payload.itemId;
    const player = players[socket.id];
    if (!player || !player.characterId || !itemId) return;

    const client = await db.pool.connect();
    let failure = null;
    let unequippedName = null;

    try {
      await client.query('BEGIN');

      const item = await loadInventoryItem(client, itemId, player.characterId);
      if (!item || !item.is_equipped) {
        await client.query('ROLLBACK');
        return;
      }

      const freeSlot = await findFreeSlot(client, player.characterId);
      if (freeSlot === null) {
        await client.query('ROLLBACK');
        notify(socket, 'Tu mochila está llena.', '#ff5252');
        return;
      }

      unequippedName = item.name;
      await client.query(
        'UPDATE inventory_items SET is_equipped = FALSE, slot_index = $2 WHERE id = $1',
        [itemId, freeSlot]
      );

      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ya revertida */ }
      failure = error;
    } finally {
      client.release();
    }

    if (failure) {
      console.error(`⚠️ Error al desequipar en ${player.name}:`, failure.message);
      notify(socket, 'No se pudo desequipar el ítem.', '#ff5252');
      return;
    }

    notify(socket, `Desequipas ${unequippedName}.`);
    emitInventory(socket);
  });

  // Comprar al comerciante (Módulo E, panel de tienda con la tecla E)
  socket.on('buyItem', async (payload) => {
    const templateId = Number(payload && payload.itemTemplateId);
    const player = players[socket.id];

    if (!player || !player.characterId || !templateId) return;

    if (!isNearMerchant(player)) {
      shopResult(socket, false, 'Estás demasiado lejos del comerciante.');
      return;
    }

    const item = findStockItem(templateId);
    if (!item) {
      shopResult(socket, false, 'El comerciante no vende eso.');
      return;
    }

    // El oro y el ítem cambian juntos: sin casillero libre no se cobra nada, y la
    // bolsa se valida contra la base dentro del mismo bloqueo, porque dos clics
    // seguidos leerían el mismo oro en memoria y podrían gastarlo dos veces.
    const client = await db.pool.connect();
    let failure = null;
    let full = false;
    let broke = false;

    try {
      await client.query('BEGIN');

      // Bloquea la fila del personaje: serializa sus transacciones y deja la
      // elección de casillero libre a salvo de carreras
      const locked = await client.query(
        'SELECT gold FROM characters WHERE id = $1 FOR UPDATE',
        [player.characterId]
      );

      const available = locked.rows[0] ? Number(locked.rows[0].gold) : 0;

      if (available < item.price) {
        broke = true;
        await client.query('ROLLBACK');
      } else {
        const inserted = await client.query(
          `INSERT INTO inventory_items (character_id, item_template_id, slot_index)
           SELECT $1, $2, slot
             FROM generate_series(0, 29) AS slot
            WHERE NOT EXISTS (
                  SELECT 1 FROM inventory_items i
                   WHERE i.character_id = $1 AND i.slot_index = slot
            )
            ORDER BY slot
            LIMIT 1
           RETURNING slot_index`,
          [player.characterId, item.templateId]
        );

        if (inserted.rowCount === 0) {
          full = true;
          await client.query('ROLLBACK');
        } else {
          await client.query(
            'UPDATE characters SET gold = gold - $2 WHERE id = $1',
            [player.characterId, item.price]
          );
          await client.query('COMMIT');
        }
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ya revertida */ }
      failure = error;
    } finally {
      client.release();
    }

    if (failure) {
      console.error(`⚠️ No se pudo completar la compra de ${player.name}:`, failure.message);
      shopResult(socket, false, 'No se pudo completar la compra.');
      return;
    }

    if (full) {
      shopResult(socket, false, 'Tu inventario está lleno.');
      return;
    }

    if (broke) {
      shopResult(socket, false, `Te falta oro: ${item.name} cuesta ${item.price}.`);
      return;
    }

    player.gold -= item.price;

    shopResult(socket, true, `Compras ${item.name} por ${item.price} de oro.`);
    emitStats(socket);
    emitInventory(socket);
  });

  // Vender al comerciante: paga la mitad del costo base del ítem
  socket.on('sellItem', async (payload) => {
    const itemId = payload && payload.itemId;
    const player = players[socket.id];

    if (!player || !player.characterId || !itemId) return;

    if (!isNearMerchant(player)) {
      shopResult(socket, false, 'Estás demasiado lejos del comerciante.');
      return;
    }

    let owned = null;
    try {
      const result = await db.query(
        `SELECT i.id, i.is_equipped, i.enhance_level, t.name, t.sprite_id
           FROM inventory_items i
           JOIN item_templates t ON t.id = i.item_template_id
          WHERE i.id = $1 AND i.character_id = $2`,
        [itemId, player.characterId]
      );
      owned = result.rows[0] || null;
    } catch (error) {
      console.error(`⚠️ No se pudo consultar el ítem de ${player.name}:`, error.message);
      shopResult(socket, false, 'No se pudo completar la venta.');
      return;
    }

    if (!owned) return;

    // Solo se vende lo que está en la mochila: lo equipado se desequipa antes
    if (owned.is_equipped) {
      shopResult(socket, false, 'Desequipa el ítem antes de venderlo.');
      return;
    }

    const catalogItem = CATALOG_BY_NAME[owned.name];
    if (!catalogItem || salePrice(catalogItem) <= 0) {
      shopResult(socket, false, 'Ese ítem no tiene valor de venta.');
      return;
    }

    const price = salePrice(catalogItem);

    // El DELETE vuelve a comprobar que siga en la mochila: entre la lectura y la
    // venta el ítem pudo equiparse o consumirse.
    const client = await db.pool.connect();
    let failure = null;
    let gone = false;

    try {
      await client.query('BEGIN');

      // Misma serialización que en la compra: el oro de dos ventas a la vez no
      // puede pisarse
      await client.query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);

      const removed = await client.query(
        'DELETE FROM inventory_items WHERE id = $1 AND character_id = $2 AND is_equipped = FALSE',
        [itemId, player.characterId]
      );

      if (removed.rowCount === 0) {
        gone = true;
        await client.query('ROLLBACK');
      } else {
        await client.query(
          'UPDATE characters SET gold = gold + $2 WHERE id = $1',
          [player.characterId, price]
        );
        await client.query('COMMIT');
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ya revertida */ }
      failure = error;
    } finally {
      client.release();
    }

    if (failure) {
      console.error(`⚠️ No se pudo completar la venta de ${player.name}:`, failure.message);
      shopResult(socket, false, 'No se pudo completar la venta.');
      return;
    }

    if (gone) {
      shopResult(socket, false, 'Ese ítem ya no está en tu mochila.');
      return;
    }

    player.gold += price;

    shopResult(socket, true, `Vendes ${owned.name} por ${price} de oro.`);
    emitStats(socket);
    emitInventory(socket);
  });

  // Reparte un punto de estadística (Módulo D, panel de personaje con la tecla C)
  socket.on('assignStatPoint', async (payload) => {
    const attribute = payload && payload.attribute;
    const player = players[socket.id];

    if (!player || !player.characterId) return;

    if (!ASSIGNABLE_ATTRIBUTES.includes(attribute)) {
      notify(socket, 'Atributo desconocido.', '#ff5252');
      return;
    }

    if (player.statPoints <= 0) {
      notify(socket, 'No te quedan puntos de estadística.', '#ff5252');
      return;
    }

    // Se calcula el estado resultante completo y solo se aplica si la base confirma
    const next = {
      fuerza: player.fuerza,
      agilidad: player.agilidad,
      inteligencia: player.inteligencia,
      vitalidad: player.vitalidad,
      statPoints: player.statPoints - 1,
      hpMax: player.hpMax,
      hpCurrent: player.hpCurrent,
      mpMax: player.mpMax,
      mpCurrent: player.mpCurrent
    };

    next[attribute] += 1;

    if (attribute === 'vitalidad') {
      next.hpMax += HP_POR_VITALIDAD;
      next.hpCurrent += HP_POR_VITALIDAD;
    } else if (attribute === 'inteligencia') {
      next.mpMax += MP_POR_INTELIGENCIA;
      next.mpCurrent += MP_POR_INTELIGENCIA;
    }

    try {
      await db.query(
        `UPDATE characters
            SET fuerza = $1, agilidad = $2, inteligencia = $3, vitalidad = $4,
                stat_points = $5, hp_max = $6, hp_current = $7, mp_max = $8, mp_current = $9
          WHERE id = $10`,
        [next.fuerza, next.agilidad, next.inteligencia, next.vitalidad, next.statPoints,
          next.hpMax, next.hpCurrent, next.mpMax, next.mpCurrent, player.characterId]
      );
    } catch (error) {
      console.error(`⚠️ No se pudo repartir el punto de ${player.name}:`, error.message);
      notify(socket, 'No se pudo asignar el punto.', '#ff5252');
      return;
    }

    Object.assign(player, next);

    notify(socket, `${ATTRIBUTE_LABELS[attribute]} +1 (te quedan ${player.statPoints} puntos).`, '#a5d6a7');
    emitStats(socket);
  });

  // --- Clanes (Módulo H) ---
  // La ventana de clan (tecla K) y los comandos de chat piden lo mismo: aquí vive
  // una sola versión de cada acción y los dos caminos la comparten.

  async function handleCreateClan(rawName) {
    const player = players[socket.id];
    if (!player) return;

    const result = await clanController.createClan({
      characterId: player.characterId,
      name: rawName
    });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    // La fundación se cobra en la base de datos: el oro en memoria baja igual
    player.gold = Math.max(0, player.gold - result.cost);

    await syncPlayerClan(player);
    emitStats(socket);
    notify(socket, `Has fundado el clan ${result.clan.name} <${result.clan.tag}>.`, '#ffd700');
  }

  async function handleInvite(rawName) {
    const player = players[socket.id];
    if (!player) return;

    const result = await clanController.inviteToClan({
      characterId: player.characterId,
      targetName: rawName
    });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    notify(socket, `Has invitado a ${result.targetName} al clan ${result.clanName}.`, '#ffd700');

    // Si el invitado está conectado se le avisa en el momento; si no, la invitación
    // le espera en la base de datos
    const guest = Object.values(players).find((p) => p.characterId === result.targetId);
    const guestSocket = guest && io.sockets.sockets.get(guest.playerId);

    if (guestSocket) {
      guestSocket.emit('clanInviteReceived', {
        clanId: result.clanId,
        clanName: result.clanName,
        from: player.name
      });
      notify(guestSocket, `${player.name} te invita al clan ${result.clanName}. Acepta con /aceptarclan.`, '#ffd700');
    }
  }

  async function handleAcceptInvite(clanId) {
    const player = players[socket.id];
    if (!player) return;

    const result = await clanController.acceptInvite({
      characterId: player.characterId,
      clanId: clanId || null
    });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    await syncPlayerClan(player);
    notify(socket, `Te has unido al clan ${result.clanName}.`, '#ffd700');

    // El resto del clan ve al nuevo miembro
    await refreshClanMembers(player.clanId);
  }

  async function handleLeaveClan() {
    const player = players[socket.id];
    if (!player) return;

    const previousClanId = player.clanId;
    const result = await clanController.leaveClan({ characterId: player.characterId });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    await syncPlayerClan(player);
    notify(socket, 'Has abandonado el clan.', '#ffd700');
    await refreshClanMembers(previousClanId);
  }

  async function handleKick(rawName) {
    const player = players[socket.id];
    if (!player) return;

    const result = await clanController.kickFromClan({
      characterId: player.characterId,
      targetName: rawName
    });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    notify(socket, `${result.targetName} ya no está en el clan.`, '#ffd700');

    const kicked = Object.values(players).find((p) => p.characterId === result.targetId);

    if (kicked) {
      await syncPlayerClan(kicked);
      notifyPlayer(kicked, 'Te han expulsado del clan.', '#ff5252');
    }

    await refreshClanMembers(result.clanId);
  }

  async function handleDissolveClan() {
    const player = players[socket.id];
    if (!player) return;

    const result = await clanController.dissolveClan({ characterId: player.characterId });

    if (!result.ok) {
      notify(socket, result.text, '#ff8a80');
      return;
    }

    // Todos los miembros en línea pierden la etiqueta a la vez
    const members = Object.values(players).filter((p) => p.clanId === result.clanId);

    await Promise.all(members.map(async (member) => {
      await syncPlayerClan(member);
      notifyPlayer(member, `El clan ${result.clanName} ha sido disuelto.`, '#ff8a80');
    }));
  }

  socket.on('createClan', (payload) => handleCreateClan(payload && (payload.clanName || payload.name)));
  socket.on('inviteToClan', (payload) => handleInvite(payload && (payload.playerName || payload.targetName)));
  socket.on('acceptClanInvite', (payload) => handleAcceptInvite(payload && payload.clanId));
  socket.on('leaveClan', () => handleLeaveClan());
  socket.on('kickFromClan', (payload) => handleKick(payload && (payload.playerName || payload.targetName)));
  socket.on('dissolveClan', () => handleDissolveClan());

  // La ventana de clan pide la ficha cada vez que se abre
  socket.on('requestClan', async () => {
    const player = players[socket.id];
    if (!player) return;

    socket.emit('clanInfo', await clanStateFor(player));
  });

  // Chat y Comandos
  socket.on('sendChatMessage', async (message) => {
    const text = message.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      const [rawCommand, ...rest] = text.split(' ');
      const command = rawCommand.toLowerCase();
      const argument = rest.join(' ').trim();

      if (command === '/online') {
        const player = players[socket.id];
        const here = player ? playersInMap(player.mapId).length : 0;

        socket.emit('chatMessage', {
          sender: 'SISTEMA',
          text: `Jugadores en este mapa: ${here}`,
          color: '#ffeb3b'
        });
        return;
      }

      // Comandos de clan (Módulo H)
      if (command === '/crearclan') { await handleCreateClan(argument); return; }
      if (command === '/invitar') { await handleInvite(argument); return; }
      if (command === '/aceptarclan') { await handleAcceptInvite(null); return; }
      if (command === '/salirclan') { await handleLeaveClan(); return; }
      if (command === '/expulsar') { await handleKick(argument); return; }
      if (command === '/disolverclan') { await handleDissolveClan(); return; }
    }

    // Chat zonal: solo lo lee quien está en el mismo mapa
    const speaker = players[socket.id];

    if (!speaker) return;

    emitToMap(speaker.mapId, 'chatMessage', {
      playerId: socket.id,
      sender: speaker.name,
      text,
      color: '#ffffff'
    });
  });

  // Cierre de sesión pedido desde el menú de opciones (tecla Esc)
  socket.on('requestLogout', (payload) => {
    const player = players[socket.id];
    if (!player) return;

    const action = payload && payload.action;
    if (!LOGOUT_ACTIONS.includes(action)) return;

    // Ya hay una cuenta regresiva en marcha: no se reinicia
    if (player.pendingLogout) return;

    const inCombat = Date.now() - player.lastCombatTime < COMBAT_LOGOUT_BLOCK_MS;

    if (!inCombat) {
      finalizeLogout(socket, action);
      return;
    }

    // En combate hay que esperar; moverse o atacar cancela la espera
    player.pendingLogout = {
      action,
      timer: setTimeout(() => finalizeLogout(socket, action), LOGOUT_COUNTDOWN_SECONDS * 1000)
    };

    socket.emit('logoutCountdown', { seconds: LOGOUT_COUNTDOWN_SECONDS });
  });

  // Desconexión
  socket.on('disconnect', () => {
    const player = players[socket.id];

    // Sin jugador en memoria ya se había cerrado sesión: no se repite el aviso
    if (!player) return;

    console.log(`❌ Desconectado: ${player.name}`);
    delete players[socket.id];

    // El aviso sale solo a su zona: los demás mapas no lo han visto nunca
    io.to(mapRoom(player.mapId)).emit('playerDisconnected', socket.id);
  });
});

// Resolver los templates de ítems en PostgreSQL antes de aceptar jugadores: si
// no, los templateId llegarían vacíos y ni recoger ni comprar funcionarían.
ensureItemTemplates()
  .catch((error) => {
    console.error('⚠️ No se pudieron preparar los templates de ítems:', error.message);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Servidor Elysia Online activo en http://localhost:${PORT}`);

      // El servidor simula proyectiles y regenera vida y maná con sus propios
      // relojes: no depende de que nadie pulse nada.
      setInterval(tickProjectiles, PROJECTILE_TICK_MS);
      setInterval(regeneratePlayers, REGEN_INTERVAL_MS);
    });
  });