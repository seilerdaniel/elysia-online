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
const db = require('./config/db');

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

// Tabla de botín por monstruo (de más común a más raro).
// Se tira en orden y se detiene en el primer acierto: máximo un ítem por muerte.
const monsters = {
  m1: {
    id: 'm1', name: 'Trasgo', x: 250, y: 200, hp: 50, maxHp: 50, alive: true, xp: 25, gold: 15,
    drops: [
      { itemKey: 'potion_health', chance: 0.40 },
      { itemKey: 'sword_iron', chance: 0.15 },
      { itemKey: 'gem_light', chance: 0.05 }
    ]
  },
  m2: {
    id: 'm2', name: 'Orco', x: 550, y: 350, hp: 80, maxHp: 80, alive: true, xp: 50, gold: 30,
    drops: [
      { itemKey: 'potion_mana', chance: 0.35 },
      { itemKey: 'shield_oak', chance: 0.12 },
      { itemKey: 'soul_sphere', chance: 0.03 }
    ]
  },
  m3: {
    id: 'm3', name: 'Demonio', x: 350, y: 450, hp: 120, maxHp: 120, alive: true, xp: 90, gold: 60,
    drops: [
      { itemKey: 'plate_armor', chance: 0.08 },
      { itemKey: 'soul_sphere', chance: 0.08 },
      { itemKey: 'chaos_stone', chance: 0.02 }
    ]
  }
};

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
const MERCHANT = {
  id: 'merchant_1',
  name: 'Comerciante',
  x: 300,
  y: 300
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

  if (leveledUp) {
    io.emit('playerLeveledUp', {
      characterId: player.characterId,
      playerId: player.playerId,
      level: player.level,
      statPoints: player.statPoints
    });

    // El panel de personaje debe reflejar el nivel nuevo y los puntos ganados
    const socket = io.sockets.sockets.get(player.playerId);
    if (socket) emitStats(socket);
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
            SET pos_x = $1, pos_y = $2, hp_current = $3, mp_current = $4,
                experience = $5, gold = $6, stat_points = $7
          WHERE id = $8`,
        [
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
  io.emit('playerDisconnected', socket.id);
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

  worldDrops[dropId] = {
    dropId,
    itemKey,
    name: item.name,
    spriteId: item.spriteId,
    x: monster.x,
    y: monster.y,
    despawnTimer: setTimeout(() => {
      delete worldDrops[dropId];
      io.emit('itemDespawned', { dropId });
    }, DROP_DESPAWN_MS)
  };

  io.emit('itemDropped', publicDrop(worldDrops[dropId]));
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

// El comercio exige estar junto al NPC; el cliente solo sugiere la intención
function isNearMerchant(player) {
  return Math.hypot(player.x - MERCHANT.x, player.y - MERCHANT.y) <= SHOP_RANGE;
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

io.on('connection', (socket) => {
  const char = socket.character || {};
  console.log(`🎮 Personaje conectado: ${char.name || socket.id}`);

  // La posición se guarda al cerrar sesión (Módulo F): al volver, el personaje
  // aparece donde quedó. Sin coordenadas válidas cae al centro del mapa.
  const spawnX = Number(char.pos_x);
  const spawnY = Number(char.pos_y);

  players[socket.id] = {
    playerId: socket.id,
    userId: socket.user.userId,
    characterId: char.id || null,
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
    x: Number.isFinite(spawnX) ? spawnX : 400,
    y: Number.isFinite(spawnY) ? spawnY : 320,
    lastCombatTime: 0,   // 0 = nunca ha combatido en esta sesión
    pendingLogout: null  // cuenta regresiva de cierre de sesión en curso
  };

  // Enviar estado inicial al jugador entrante
  socket.emit('currentPlayers', players);
  socket.emit('currentMonsters', monsters);
  socket.emit('currentDrops', Object.values(worldDrops).map(publicDrop));
  socket.emit('currentNpcs', [publicNpc(MERCHANT)]);
  socket.emit('shopCatalog', publicShopCatalog());
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Inventario y estadísticas del personaje
  emitInventory(socket, 'currentInventory');
  emitStats(socket);

  // Movimiento
  socket.on('playerMovement', (movementData) => {
    const player = players[socket.id];
    if (!player) return;

    // Moverse cancela un cierre de sesión en curso
    cancelPendingLogout(player);

    player.x = movementData.x;
    player.y = movementData.y;
    socket.broadcast.emit('playerMoved', player);
  });

  // Combate (Ataque con Espacio)
  socket.on('playerAttack', () => {
    const player = players[socket.id];
    if (!player) return;

    // Atacar cancela un cierre de sesión en curso, aunque no acierte
    cancelPendingLogout(player);

    // Buscar monstruos vivos dentro del rango de ataque melee (60px)
    Object.values(monsters).forEach((m) => {
      if (!m.alive) return;

      const dist = Math.hypot(player.x - m.x, player.y - m.y);
      if (dist <= 60) {
        // Golpear a alguien es lo que cuenta como estar en combate
        markInCombat(player);

        const damage = Math.floor(Math.random() * 15) + 10; // Daño entre 10 y 25
        m.hp = Math.max(0, m.hp - damage);

        io.emit('monsterDamaged', {
          monsterId: m.id,
          damage,
          currentHp: m.hp,
          maxHp: m.maxHp
        });

        // Muerte y Respawn
        if (m.hp <= 0) {
          m.alive = false;
          io.emit('monsterKilled', { monsterId: m.id, killedBy: player.name });

          // Recompensas de combate (XP + Oro) para el jugador atacante
          grantCombatRewards(player, m);

          // Tirada de botín en el suelo
          spawnDrop(m);

          setTimeout(() => {
            m.hp = m.maxHp;
            m.alive = true;
            io.emit('monsterRespawned', m);
          }, 5000); // Reaparece a los 5 segundos
        }
      }
    });
  });

  // Recoger un ítem del suelo (tecla G en el cliente)
  socket.on('pickUpItem', async (payload) => {
    const dropId = payload && payload.dropId;
    const player = players[socket.id];
    if (!player || !dropId) return;

    const drop = worldDrops[dropId];
    if (!drop) return;

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
    io.emit('itemPickedUp', { dropId });
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

  // Chat y Comandos
  socket.on('sendChatMessage', (message) => {
    const text = message.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      if (text.toLowerCase() === '/online') {
        const count = Object.keys(players).length;
        socket.emit('chatMessage', {
          sender: 'SISTEMA',
          text: `Jugadores en línea: ${count}`,
          color: '#ffeb3b'
        });
        return;
      }
    }

    io.emit('chatMessage', {
      playerId: socket.id,
      sender: players[socket.id]?.name || 'Anónimo',
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
    io.emit('playerDisconnected', socket.id);
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
    });
  });