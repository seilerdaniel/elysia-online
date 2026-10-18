import Phaser from 'phaser';
import { io } from 'socket.io-client';
import InventoryWindow from '../ui/InventoryWindow';
import CharacterWindow from '../ui/CharacterWindow';
import SettingsWindow from '../ui/SettingsWindow';
import ShopWindow from '../ui/ShopWindow';
import ClanWindow from '../ui/ClanWindow';
import { findActionByKey, loadKeybinds, resolveKeyCode, saveKeybinds } from '../config/keybinds';

// Debe coincidir con PICKUP_RANGE del servidor
const PICKUP_RANGE = 40;

// Debe coincidir con SHOP_RANGE del servidor
const SHOP_RANGE = 50;

// --- Bando y clan (Módulo H) --------------------------------------------------
// El color del nombre cuenta el bando: azul ciudadano, rojo renegado, gris
// neutral y dorado para un héroe de karma alto.
const FACTION_COLORS = {
  Ciudadano: '#4fc3f7',
  Renegado: '#ff5252',
  Neutral: '#b0bec5'
};

const HERO_COLOR = '#ffd700';
const CLAN_LABEL_COLOR = '#ffd700';

// Altura del nombre sobre la cabeza y hueco que se le hace a la etiqueta de clan
const LABEL_BASE_Y = 25;
const CLAN_LABEL_GAP = 13;

// --- Mundo por mapas (Módulo I) -----------------------------------------------
// Cada mapa ocupa una cuadrícula de 100 x 100 tiles de 32 px. El servidor usa
// los mismos 3200 px como límites del mundo, así que estas cifras se mueven
// juntas: si una cambia, la otra deja de cuadrar.
const TILE_SIZE = 32;
const TILES_PER_SIDE = 100;
const MAP_SIZE = TILE_SIZE * TILES_PER_SIDE; // 3200 x 3200 px

// Aspecto del suelo por mapa. El tinte es lo que hace evidente que se ha
// cambiado de zona antes de leer el nombre del mapa.
const MAP_STYLES = {
  1: { tint: null, road: true },        // Ciudad de Ullathorpe: camino de piedra
  2: { tint: 0x86a98f, road: false }    // Bosque Nublado: hierba apagada
};

// Portales (Módulo I). El aro marca dónde se viaja y el nombre dice a dónde: los
// dos datos los manda el servidor al entrar en la zona.
const PORTAL_COLOR = 0x66fcf1;
const PORTAL_LABEL_COLOR = '#66fcf1';

// Duración del fundido de entrada y de salida al cambiar de mapa
const FADE_MS = 300;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.player = null;
    this.otherPlayers = null;
    this.monstersGroup = null;
    this.worldDropSprites = null;
    this.npcSprites = null;
    this.socket = null;
    this.inventoryWindow = null;
    this.characterWindow = null;
    this.settingsWindow = null;
    this.shopWindow = null;
    this.playerStats = null;
    this.keybinds = null;
    this.chatInputHandlers = null;
    this.projectiles = null;
    this.skillInfo = null;
    this.localBars = null;
    this.terrain = null;
    this.mapId = 1;
    this.mapInfo = null;
    this.portals = [];
    this.portalLayer = null;
    this.travelling = false;
    this.blockedPortalId = null;
    this.travelTimer = null;
    this.travelGuardTimer = null;
    this.localLabelOffset = 0;
    this.speed = 160;
    this.isChatting = false;
    this.activeCharacter = null;
    this.token = null;
  }

  init(data) {
    if (data && data.character) {
      this.activeCharacter = data.character;
      this.token = data.token;
    }
  }

  create() {
    // 1. Evitar que Phaser capture teclas globales cuando se interactúa con inputs HTML
    this.input.keyboard.disableGlobalCapture();

    // 2. Configurar elementos del HUD de Chat HTML
    const chatWrapper = document.getElementById('chat-wrapper');
    const chatInput = document.getElementById('chat-input');

    if (chatWrapper) {
      chatWrapper.classList.remove('hidden');
    }

    // El input del chat vive fuera del lienzo y sobrevive al reinicio de la
    // escena: se guardan las referencias para poder soltarlas en cleanup().
    if (chatInput) {
      const stopPropagation = (event) => event.stopPropagation();
      const onSend = (event) => {
        if (event.key === 'Enter') {
          this.toggleChat();
        }
      };

      this.chatInputHandlers = [
        ['keydown', stopPropagation],
        ['keyup', stopPropagation],
        ['keypress', stopPropagation],
        ['keydown', onSend]
      ];

      // Detener la propagación de teclas para habilitar WASD, espacio y letras en el chat
      this.chatInputHandlers.forEach(([eventType, handler]) => {
        chatInput.addEventListener(eventType, handler);
      });
    }

    // Cerrar sesión reinicia esta misma escena: los listeners de fuera del
    // lienzo y el socket deben soltarse en el apagado, no al cerrar la página
    this.events.once('shutdown', () => this.cleanup());

    // 3. Terreno del mapa y límites del mundo (100 x 100 tiles)
    this.buildTerrain(this.mapId);
    this.physics.world.setBounds(0, 0, MAP_SIZE, MAP_SIZE);
    this.cameras.main.setBounds(0, 0, MAP_SIZE, MAP_SIZE);

    this.otherPlayers = this.physics.add.group();
    this.monstersGroup = new Map();
    this.worldDropSprites = new Map();
    this.npcSprites = new Map();
    this.projectiles = new Map();

    // 4. Conectar WebSockets pasando Token JWT y datos del personaje
    this.socket = io('http://localhost:5000', {
      auth: {
        token: this.token,
        character: this.activeCharacter
      }
    });

    // 5. Ventana de inventario en Canvas (se abre con la tecla I)
    this.inventoryWindow = new InventoryWindow(this, this.socket);
    this.updateInventoryPlayer();

    // 6. Panel de personaje en Canvas (se abre con la tecla C)
    this.characterWindow = new CharacterWindow(this, this.socket);
    this.characterWindow.setIdentity({
      name: this.activeCharacter?.name,
      characterClass: this.activeCharacter?.character_class
    });

    // 7. Menú de opciones en Canvas (se abre con Esc): reasigna controles y cierra sesión
    this.keybinds = loadKeybinds();
    this.settingsWindow = new SettingsWindow(this, this.socket, {
      keybinds: this.keybinds,
      onKeybindChange: (keybinds) => {
        this.keybinds = keybinds;
        saveKeybinds(keybinds);
      }
    });

    // 8. Tienda del comerciante en Canvas (se abre con la tecla E junto al NPC)
    this.shopWindow = new ShopWindow(this, this.socket);

    // 9. Ventana de clan en Canvas (se abre con la tecla K)
    this.clanWindow = new ClanWindow(this, this.socket);

    this.socket.on('clanInfo', (state) => this.clanWindow.setClanState(state));
    this.socket.on('clanInviteReceived', (invite) => this.clanWindow.addInvite(invite));

    // 10. Los paneles son HUD: siguen anclados a la pantalla aunque la cámara
    // siga al personaje por un mundo de 3200 px
    [
      this.inventoryWindow,
      this.characterWindow,
      this.settingsWindow,
      this.shopWindow,
      this.clanWindow
    ].forEach((panel) => this.pinToScreen(panel));

    // --- Eventos de WebSockets: Jugadores ---
    this.socket.on('currentPlayers', (players) => {
      Object.keys(players).forEach((id) => {
        if (players[id].playerId === this.socket.id) {
          this.addLocalPlayer(players[id]);
        } else {
          this.addOtherPlayer(players[id]);
        }
      });
    });

    this.socket.on('newPlayer', (playerInfo) => {
      this.addOtherPlayer(playerInfo);
    });

    this.socket.on('playerMoved', (playerInfo) => {
      this.otherPlayers.getChildren().forEach((otherPlayer) => {
        if (playerInfo.playerId === otherPlayer.playerId) {
          otherPlayer.setPosition(playerInfo.x, playerInfo.y);
          this.placeOverheadLabels(otherPlayer);

          if (otherPlayer.speechBubble) {
            otherPlayer.speechBubble.setPosition(playerInfo.x, playerInfo.y - 42);
          }
        }
      });
    });

    this.socket.on('playerDisconnected', (playerId) => {
      this.otherPlayers.getChildren().forEach((op) => {
        if (playerId === op.playerId) {
          if (op.nameText) op.nameText.destroy();
          if (op.clanText) op.clanText.destroy();
          if (op.speechBubble) op.speechBubble.destroy();
          op.destroy();
        }
      });
    });

    // Bando y karma (Módulo H): el nombre cambia de color al instante
    this.socket.on('playerFactionUpdated', (data) => {
      const target = this.findPlayerByCharacterId(data.characterId);
      if (!target || !target.nameText) return;

      target.faction = data.faction;
      target.hero = Boolean(data.hero);
      target.nameText.setColor(this.factionColor(data));
    });

    // Etiqueta de clan (Módulo H): aparece, cambia de nombre o desaparece
    this.socket.on('playerClanUpdated', (data) => {
      const target = this.findPlayerByCharacterId(data.characterId);
      if (!target) return;

      this.setClanLabel(target, data, target === this.player);
    });

    // Subida de nivel: actualiza la etiqueta, muestra texto flotante y destello
    this.socket.on('playerLeveledUp', (data) => {
      const target = this.findPlayerByCharacterId(data.characterId);
      if (!target) return;

      if (target.nameText) {
        target.nameText.setText(`${target.playerName} [Niv.${data.level}]`);
      }

      this.showLevelUpText(target);
      this.playLevelUpFlash(target);

      // El nivel del jugador local cambia los requisitos de equipamiento
      this.updateInventoryPlayer(data.level);
    });

    // --- Eventos de WebSockets: Monstruos y Combate ---
    this.socket.on('currentMonsters', (monsters) => {
      Object.values(monsters).forEach((m) => {
        if (m.alive) this.addMonster(m);
      });
    });

    this.socket.on('monsterDamaged', (data) => {
      const monsterData = this.monstersGroup.get(data.monsterId);
      if (monsterData) {
        this.updateMonsterHpBar(monsterData, data.currentHp, data.maxHp);
        this.showDamageText(monsterData.sprite.x, monsterData.sprite.y, data.damage, data.critical);

        // Destello rojo al sufrir daño
        this.tweens.add({
          targets: monsterData.sprite,
          tint: 0xff0000,
          duration: 100,
          yoyo: true,
          onComplete: () => monsterData.sprite.clearTint()
        });
      }
    });

    this.socket.on('monsterKilled', (data) => {
      const monsterData = this.monstersGroup.get(data.monsterId);
      if (monsterData) {
        monsterData.sprite.destroy();
        monsterData.nameText.destroy();
        monsterData.hpBg.destroy();
        monsterData.hpBar.destroy();
        this.monstersGroup.delete(data.monsterId);
      }
    });

    this.socket.on('monsterRespawned', (m) => {
      this.addMonster(m);
    });

    // --- Eventos de WebSockets: Habilidades y proyectiles (Módulo G) ---
    this.socket.on('skillInfo', (skill) => {
      this.skillInfo = skill;
    });

    this.socket.on('skillDenied', (data) => {
      // El servidor rechazó el lanzamiento: se avisa sin haber gastado maná
      if (this.player) {
        this.showFloatingText(this.player.x, this.player.y - 45, data.text, '#ff8a80', 11, 30);
      }
      this.appendChatMessage({ sender: 'SISTEMA', text: data.text, color: '#ff8a80' });
    });

    this.socket.on('projectileSpawned', (data) => {
      this.addProjectile(data);
    });

    this.socket.on('projectileMoved', (data) => {
      const projectile = this.projectiles.get(data.id);
      if (!projectile) return;

      // El servidor dice hasta dónde ha llegado; el sprite se desliza hacia ahí
      projectile.targetX = data.x;
      projectile.targetY = data.y;
    });

    this.socket.on('projectileHit', (data) => {
      this.removeProjectile(data);
    });

    this.socket.on('skillArc', (data) => {
      this.playSkillArc(data);
    });

    this.socket.on('skillBlink', (data) => {
      this.playSkillBlink(data);
    });

    this.socket.on('playerDamaged', (data) => {
      this.showPlayerDamage(data);
    });

    this.socket.on('playerRespawned', (data) => {
      this.movePlayerTo(data);
    });

    // --- Eventos de WebSockets: Ítems en el suelo ---
    this.socket.on('currentDrops', (drops) => {
      drops.forEach((drop) => this.addWorldDrop(drop));
    });

    this.socket.on('itemDropped', (drop) => {
      this.addWorldDrop(drop);
    });

    this.socket.on('itemPickedUp', (data) => {
      this.removeWorldDrop(data.dropId);
    });

    this.socket.on('itemDespawned', (data) => {
      this.removeWorldDrop(data.dropId);
    });

    // --- Eventos de WebSockets: NPCs y comercio ---
    this.socket.on('currentNpcs', (npcs) => {
      npcs.forEach((npc) => this.addNpc(npc));
    });

    this.socket.on('shopCatalog', (catalog) => {
      this.shopWindow.setCatalog(catalog);
    });

    this.socket.on('shopResult', (result) => {
      this.shopWindow.showResult(result);

      // El chat guarda el historial aunque la tienda esté cerrada
      this.appendChatMessage({
        sender: 'SISTEMA',
        text: result.text,
        color: result.ok ? '#a5d6a7' : '#ff8a80'
      });
    });

    // --- Eventos de WebSockets: Mapas y portales (Módulo I) ---
    // La zona la manda el servidor: al entrar llega mapInfo y al viajar llega
    // mapChangeSuccess con el mapa entero ya montado.
    this.socket.on('mapInfo', (info) => this.applyMap(info));

    this.socket.on('mapChangeSuccess', (data) => this.onMapChangeSuccess(data));

    // El portal no se activó: se vuelve a ver el mapa y no se insiste hasta salir
    // del aro, o el personaje se quedaría rebotando en la puerta
    this.socket.on('mapChangeDenied', () => this.cancelTravel());

    // --- Eventos de WebSockets: Inventario ---
    this.socket.on('currentInventory', (items) => {
      this.inventoryWindow.setItems(items);
      this.shopWindow.setBackpack(items);
    });

    this.socket.on('inventoryUpdated', (items) => {
      this.inventoryWindow.setItems(items);
      this.shopWindow.setBackpack(items);
    });

    this.socket.on('playerStatsUpdated', (stats) => {
      this.playerStats = stats;
      this.inventoryWindow.setStats(stats);
      this.characterWindow.setStats(stats);
      this.shopWindow.setStats(stats);
      this.updateInventoryPlayer(stats.level);
      this.updateLocalBars();
    });

    // --- Eventos de WebSockets: Sesión ---
    this.socket.on('logoutCountdown', (data) => {
      // El servidor exige esperar para salir estando en combate
      this.settingsWindow.showLogoutCountdown(data.seconds);
    });

    this.socket.on('logoutSuccess', (data) => {
      this.handleLogoutSuccess(data.action);
    });

    // --- Eventos de WebSockets: Chat ---
    this.socket.on('chatMessage', (data) => {
      this.appendChatMessage(data);
      if (data.playerId === this.socket.id && this.player) {
        this.showSpeechBubble(this.player, data.text);
      } else {
        this.otherPlayers.getChildren().forEach((op) => {
          if (op.playerId === data.playerId) {
            this.showSpeechBubble(op, data.text);
          }
        });
      }
    });

    // 9. Configurar Teclado (Movimiento WASD / Flechas)
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D
    });

    // Un único despachador: los atajos son reasignables, así que no se puede
    // registrar un manejador por tecla fija.
    this.input.keyboard.on('keydown', (event) => this.handleKeyDown(event));

    // Clic derecho: lanza la habilidad de clase apuntando al cursor
    this.input.mouse.disableContextMenu();
    this.input.on('pointerdown', (pointer) => {
      if (pointer.rightButtonDown()) this.castSkill(pointer);
    });
  }

  // --- Teclado -----------------------------------------------------------------

  handleKeyDown(event) {
    // Al dejar una tecla pulsada el navegador la repite: solo interesa la pulsación
    if (event.repeat) return;

    const code = resolveKeyCode(event);

    // Mientras se reasigna un control, la siguiente tecla es la nueva asignación
    if (this.settingsWindow.isCapturingKey) {
      this.settingsWindow.captureKey(code);
      return;
    }

    // Esc siempre abre o cierra el menú de opciones
    if (code === 'Escape') {
      if (!this.isChatting) this.toggleSettings();
      return;
    }

    if (this.isChatting || !this.player) return;

    switch (findActionByKey(this.keybinds, code)) {
      case 'attack':
        this.performAttack();
        break;
      case 'skill':
        this.castSkill();
        break;
      case 'inventory':
        if (this.inventoryWindow.toggle()) this.closeOtherWindows('inventory');
        break;
      case 'character':
        if (this.characterWindow.toggle()) this.closeOtherWindows('character');
        break;
      case 'pickup':
        this.pickUpNearestDrop();
        break;
      case 'shop':
        this.toggleShop();
        break;
      case 'clan':
        if (this.clanWindow.toggle()) this.closeOtherWindows('clan');
        break;
      case 'potionHp':
        this.usePotion('hp');
        break;
      case 'potionMp':
        this.usePotion('mp');
        break;
      case 'chat':
        this.toggleChat();
        break;
      default:
        break;
    }
  }

  performAttack() {
    // Atacar cancela cualquier cierre de sesión en curso
    this.cancelLogoutIfPending();

    this.socket.emit('playerAttack');

    // Animación de golpe en el personaje local
    this.tweens.add({
      targets: this.player,
      scaleX: 1.2,
      scaleY: 1.2,
      duration: 80,
      yoyo: true
    });
  }

  // Consume la primera poción del tipo pedido que haya en la mochila
  usePotion(stat) {
    const potion = this.inventoryWindow.items.find(
      (item) => !item.isEquipped && item.effect && item.effect.stat === stat
    );

    if (!potion) {
      this.appendChatMessage({
        sender: 'SISTEMA',
        text: stat === 'hp' ? 'No tienes pociones de vida.' : 'No tienes pociones de maná.',
        color: '#ff5252'
      });
      return;
    }

    this.socket.emit('useItem', { itemId: potion.id });
  }

  toggleSettings() {
    if (this.settingsWindow.toggle()) this.closeOtherWindows('settings');
  }

  // Todos los paneles se dibujan centrados: solo uno puede estar visible a la vez
  closeOtherWindows(keep) {
    const panels = {
      inventory: this.inventoryWindow,
      character: this.characterWindow,
      settings: this.settingsWindow,
      shop: this.shopWindow,
      clan: this.clanWindow
    };

    Object.entries(panels).forEach(([id, panel]) => {
      if (id !== keep) panel.close();
    });
  }

  cancelLogoutIfPending() {
    if (this.settingsWindow.isLogoutPending) {
      this.settingsWindow.clearLogoutRequest();
    }
  }

  handleLogoutSuccess(action) {
    this.socket.disconnect();
    this.scene.stop();

    // La pantalla de login y la de selección viven fuera del lienzo: las maneja index.js
    this.game.events.emit('session:returnToAuth', { action, token: this.token });
  }

  // Suelta todo lo que vive FUERA de la escena: si no, al volver a entrar desde
  // la selección de personaje se acumularían listeners y sockets.
  cleanup() {
    // Al apagarse la escena Phaser destruye los sprites, pero NO crea al
    // jugador: this.player solo se asigna cuando el socket entrega
    // currentPlayers. Si se conservara la referencia, update() del siguiente
    // arranque llamaría a un sprite ya destruido y la excepción mataría el
    // bucle de Phaser (el juego quedaría congelado).
    this.player = null;

    // El viaje vive fuera de la escena: un temporizador o un aro viejos no deben
    // sobrevivir al reinicio (el escenario que los dibujó ya no existe)
    this.clearTravelTimers();
    this.travelling = false;
    this.blockedPortalId = null;
    this.portals = [];
    this.portalLayer = null;
    this.mapInfo = null;
    this.terrain = null;

    const chatWrapper = document.getElementById('chat-wrapper');
    const chatInput = document.getElementById('chat-input');

    if (chatWrapper) chatWrapper.classList.add('hidden');

    if (chatInput) {
      if (this.chatInputHandlers) {
        this.chatInputHandlers.forEach(([eventType, handler]) => {
          chatInput.removeEventListener(eventType, handler);
        });
        this.chatInputHandlers = null;
      }

      chatInput.style.display = 'none';
      chatInput.value = '';
    }

    this.isChatting = false;

    if (this.socket) this.socket.disconnect();
  }

  // Mantiene sincronizados nivel y atributos que usa la ventana de inventario
  updateInventoryPlayer(level) {
    const char = this.activeCharacter || {};

    this.inventoryWindow.setPlayer({
      level: level || char.level,
      fuerza: char.fuerza,
      agilidad: char.agilidad,
      inteligencia: char.inteligencia
    });
  }

  // --- Mundo y HUD (Módulo I) --------------------------------------------------

  // Dibuja el suelo del mapa. Un único TileSprite cubre los 100 x 100 tiles: con
  // imágenes individuales serían 10.000 objetos de render para un fondo que no
  // cambia nunca.
  buildTerrain(mapId) {
    if (this.terrain) {
      this.terrain.destroy(true);
      this.terrain = null;
    }

    const style = MAP_STYLES[mapId] || MAP_STYLES[1];
    const layers = [];

    const grass = this.add.tileSprite(0, 0, MAP_SIZE, MAP_SIZE, 'grass').setOrigin(0);
    if (style.tint) grass.setTint(style.tint);

    layers.push(grass);

    // Camino de piedra en cruz por el centro: es la referencia visual que tenía
    // el mapa pequeño y sirve para orientarse en uno de 100 x 100 tiles
    if (style.road) {
      layers.push(this.add.tileSprite(
        0, MAP_SIZE / 2 - TILE_SIZE / 2, MAP_SIZE, TILE_SIZE, 'stone'
      ).setOrigin(0));

      layers.push(this.add.tileSprite(
        MAP_SIZE / 2 - TILE_SIZE / 2, 0, TILE_SIZE, MAP_SIZE, 'stone'
      ).setOrigin(0));
    }

    this.terrain = this.add.container(0, 0, layers).setDepth(-10);
  }

  // Ancla un panel a la pantalla. Phaser aplica el scrollFactor al contenedor
  // pero no a sus hijos salvo que se le pida (updateChildren): sin eso el marco
  // se quedaría quieto y el contenido se iría con el mundo.
  pinToScreen(panel) {
    if (panel && panel.container) panel.container.setScrollFactor(0, 0, true);
  }

  // --- Viaje entre zonas (Módulo I) -------------------------------------------

  // El servidor manda la zona en la que estamos: nombre, tamaño y puertas. El
  // cliente no adivina nada, dibuja lo que recibe.
  applyMap(info) {
    if (!info) return;

    this.mapId = info.mapId;
    this.mapInfo = info;
    this.buildTerrain(info.mapId);
    this.drawPortals(info.portals || []);
  }

  // Aro y nombre de cada puerta de la zona
  drawPortals(portals) {
    if (this.portalLayer) {
      this.portalLayer.destroy(true);
      this.portalLayer = null;
    }

    this.portals = portals;
    const piezas = [];

    portals.forEach((portal) => {
      const aro = this.add
        .circle(portal.x, portal.y, portal.radius, PORTAL_COLOR, 0.16)
        .setStrokeStyle(3, PORTAL_COLOR, 0.85);

      const nombre = this.add.text(portal.x, portal.y - portal.radius - 16, portal.name, {
        fontSize: '13px',
        fill: PORTAL_LABEL_COLOR,
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3
      }).setOrigin(0.5);

      piezas.push(aro, nombre);
    });

    // Por debajo de los personajes y de los monstruos, por encima del suelo
    this.portalLayer = this.add.container(0, 0, piezas).setDepth(-5);
  }

  insidePortal(portal) {
    return Phaser.Math.Distance.Between(
      this.player.x, this.player.y, portal.x, portal.y
    ) <= portal.radius;
  }

  // Un temporizador del viaje que quede vivo ensucia el mapa siguiente: se
  // cancelan todos a la vez.
  clearTravelTimers() {
    [this.travelTimer, this.travelGuardTimer].forEach((temporizador) => {
      if (temporizador) temporizador.remove(false);
    });

    this.travelTimer = null;
    this.travelGuardTimer = null;
  }

  // Pisar el aro pide el viaje. El servidor comprueba la distancia con sus
  // propias coordenadas: esto solo es la intención del cliente.
  checkPortal() {
    if (this.travelling || !this.portals.length) return;

    const portal = this.portals.find((candidato) => this.insidePortal(candidato));

    // Fuera del aro el portal vuelve a estar disponible: así se puede volver a
    // intentar el viaje después de un rechazo
    if (!portal) {
      this.blockedPortalId = null;
      return;
    }

    if (portal.id === this.blockedPortalId) return;

    this.travelling = true;
    this.blockedPortalId = portal.id;

    // El fundido tapa el salto: el viaje se pide cuando la pantalla ya está negra
    this.cameras.main.fadeOut(FADE_MS, 0, 0, 0, (camera, progress) => {
      if (progress < 1) return;
      this.socket.emit('requestMapChange', { targetMapId: portal.targetMapId });
    });

    // Red de seguridad: si el servidor no contesta, se vuelve a ver el mapa
    this.travelGuardTimer = this.time.delayedCall(FADE_MS + 2500, () => this.cancelTravel());
  }

  // Viaje rechazado o sin respuesta: se levanta el fundido y se sigue jugando
  cancelTravel() {
    if (!this.travelling) return;

    this.travelling = false;
    this.clearTravelTimers();

    this.cameras.main.fadeIn(FADE_MS, 0, 0, 0);
  }

  // Confirmación del servidor: se tira el escenario viejo y se levanta el nuevo
  // con lo que trae el propio mensaje, sin estados a medias.
  onMapChangeSuccess(data) {
    this.travelling = false;
    this.clearTravelTimers();

    this.clearMapEntities();
    this.applyMap(data);

    const propio = (data.players || {})[this.socket.id];

    // El personaje local no se recrea: se le mueve, así conserva las barras, el
    // seguimiento de la cámara y su etiqueta
    if (this.player) {
      this.player.setPosition(data.x, data.y);

      if (propio) {
        this.player.playerName = propio.name;
        this.player.faction = propio.faction;
        this.player.hero = Boolean(propio.hero);
        this.setClanLabel(this.player, propio, true);

        if (this.player.nameText) this.player.nameText.setColor(this.factionColor(propio));
      }

      this.placeOverheadLabels(this.player);
      this.updateLocalBars();
    }

    Object.keys(data.players || {}).forEach((id) => {
      if (id !== this.socket.id) this.addOtherPlayer(data.players[id]);
    });

    Object.values(data.monsters || {}).forEach((monster) => {
      if (monster.alive) this.addMonster(monster);
    });

    (data.drops || []).forEach((drop) => this.addWorldDrop(drop));
    (data.npcs || []).forEach((npc) => this.addNpc(npc));

    this.cameras.main.fadeIn(FADE_MS, 0, 0, 0);
  }

  // Vacía todo lo que pertenece al mapa que se deja atrás. El personaje local se
  // queda: es el viajero.
  clearMapEntities() {
    this.otherPlayers.getChildren().slice().forEach((otherPlayer) => {
      if (otherPlayer.nameText) otherPlayer.nameText.destroy();
      if (otherPlayer.clanText) otherPlayer.clanText.destroy();
      if (otherPlayer.speechBubble) otherPlayer.speechBubble.destroy();
      otherPlayer.destroy();
    });

    this.monstersGroup.forEach((monster) => {
      monster.sprite.destroy();
      monster.nameText.destroy();
      monster.hpBg.destroy();
      monster.hpBar.destroy();
    });
    this.monstersGroup.clear();

    Array.from(this.worldDropSprites.keys()).forEach((dropId) => this.removeWorldDrop(dropId));

    this.npcSprites.forEach((npc) => {
      npc.sprite.destroy();
      npc.label.destroy();
    });
    this.npcSprites.clear();

    // Un proyectil en vuelo no cruza un portal: se apaga con el mapa
    this.projectiles.forEach((projectile) => {
      projectile.sprite.destroy();
      projectile.trail.destroy();
    });
    this.projectiles.clear();
  }

  addLocalPlayer(playerInfo) {
    this.player = this.physics.add.sprite(playerInfo.x, playerInfo.y, 'player');
    this.player.setCollideWorldBounds(true);

    // La cámara sigue al personaje local con un suavizado (Módulo I)
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);
    this.player.playerId = playerInfo.playerId;
    this.player.characterId = playerInfo.characterId;
    this.player.playerName = playerInfo.name;
    this.player.baseTint = 0xffffff;
    this.player.faction = playerInfo.faction;
    this.player.hero = Boolean(playerInfo.hero);
    this.player.clanName = playerInfo.clanName || null;

    this.localLabelOffset = this.labelOffset(this.player);

    this.player.nameText = this.add.text(
      playerInfo.x,
      playerInfo.y - LABEL_BASE_Y - this.localLabelOffset,
      `${playerInfo.name} [Niv.${playerInfo.level}]`,
      {
        fontSize: '12px',
        fill: this.factionColor(playerInfo),
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3
      }
    ).setOrigin(0.5);

    this.setClanLabel(this.player, playerInfo, true);

    // Barras de vida y maná sobre la cabeza (Módulo G)
    this.buildLocalBars();
    this.updateLocalBars();
  }

  addOtherPlayer(playerInfo) {
    const otherPlayer = this.physics.add.sprite(playerInfo.x, playerInfo.y, 'player');
    otherPlayer.setTint(0x808080);
    otherPlayer.playerId = playerInfo.playerId;
    otherPlayer.characterId = playerInfo.characterId;
    otherPlayer.playerName = playerInfo.name;
    otherPlayer.baseTint = 0x808080;
    otherPlayer.faction = playerInfo.faction;
    otherPlayer.hero = Boolean(playerInfo.hero);
    otherPlayer.clanName = playerInfo.clanName || null;

    otherPlayer.nameText = this.add.text(
      playerInfo.x,
      playerInfo.y - LABEL_BASE_Y - this.labelOffset(otherPlayer),
      `${playerInfo.name} [Niv.${playerInfo.level}]`,
      {
        fontSize: '12px',
        fill: this.factionColor(playerInfo),
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3
      }
    ).setOrigin(0.5);

    this.setClanLabel(otherPlayer, playerInfo);

    this.otherPlayers.add(otherPlayer);
  }

  // --- Bando y clan sobre la cabeza (Módulo H) --------------------------------

  // Azul ciudadano, rojo renegado, gris neutral y dorado para los héroes
  factionColor(playerInfo) {
    if (playerInfo.hero) return HERO_COLOR;

    return FACTION_COLORS[playerInfo.faction] || FACTION_COLORS.Neutral;
  }

  // El nombre sube cuando el personaje tiene clan, para dejarle sitio debajo
  labelOffset(target) {
    return target && target.clanName ? CLAN_LABEL_GAP : 0;
  }

  // Coloca encima del personaje el nombre y, si la hay, la etiqueta de clan
  placeOverheadLabels(target) {
    const nameY = target.y - LABEL_BASE_Y - this.labelOffset(target);

    if (target.nameText) target.nameText.setPosition(target.x, nameY);
    if (target.clanText) target.clanText.setPosition(target.x, nameY + CLAN_LABEL_GAP);
  }

  // Etiqueta del clan en dorado debajo del nombre. Sin clan, desaparece y el
  // nombre vuelve a su altura de siempre.
  setClanLabel(target, playerInfo, isLocal = false) {
    target.clanName = playerInfo.clanName || null;

    if (isLocal) {
      // Las barras de vida y maná suben con el nombre para no pisarlo
      this.localLabelOffset = this.labelOffset(target);
      this.updateLocalBars();
    }

    if (!target.clanName) {
      if (target.clanText) {
        target.clanText.destroy();
        target.clanText = null;
      }

      this.placeOverheadLabels(target);
      return;
    }

    if (!target.clanText) {
      target.clanText = this.add.text(0, 0, '', {
        fontSize: '10px',
        fill: CLAN_LABEL_COLOR,
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 2
      }).setOrigin(0.5);
    }

    target.clanText.setText(`[${target.clanName}]`);
    this.placeOverheadLabels(target);
  }

  addMonster(m) {
    const sprite = this.add.sprite(m.x, m.y, 'monster');
    const nameText = this.add.text(m.x, m.y - 26, m.name, {
      fontSize: '11px',
      fill: '#ff5252',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2
    }).setOrigin(0.5);

    // Barra de Vida Overhead (Fondo Rojo + Relleno Verde)
    const hpBg = this.add.rectangle(m.x, m.y - 18, 32, 4, 0xff0000).setOrigin(0.5);
    const hpBar = this.add.rectangle(m.x - 16, m.y - 18, 32, 4, 0x00ff00).setOrigin(0, 0.5);

    this.monstersGroup.set(m.id, { sprite, nameText, hpBg, hpBar });
    this.updateMonsterHpBar({ sprite, nameText, hpBg, hpBar }, m.hp, m.maxHp);
  }

  updateMonsterHpBar(monsterData, currentHp, maxHp) {
    const pct = Math.max(0, currentHp / maxHp);
    monsterData.hpBar.width = 32 * pct;
  }

  // Número de daño flotante: amarillo el golpe normal, naranja y grande el crítico
  showDamageText(x, y, damage, critical = false) {
    this.showFloatingText(
      x,
      y - 20,
      critical ? `-${damage} ¡CRÍTICO!` : `-${damage}`,
      critical ? '#ff7043' : '#ffeb3b',
      critical ? 22 : 14,
      critical ? 60 : 45
    );
  }

  // Texto flotante que asciende y se desvanece. El tamaño y el color son lo que
  // distingue visualmente un golpe normal de un crítico.
  showFloatingText(x, y, text, color, fontSize = 14, rise = 45) {
    const big = fontSize >= 20;

    const label = this.add.text(x, y, text, {
      fontSize: `${fontSize}px`,
      fill: color,
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: big ? 5 : 3
    }).setOrigin(0.5).setDepth(120);

    this.tweens.add({
      targets: label,
      y: y - rise,
      alpha: 0,
      duration: big ? 1100 : 800,
      ease: 'Power1',
      onComplete: () => label.destroy()
    });
  }

  // --- Habilidades de clase (Módulo G) -----------------------------------------

  // Barras de vida (verde) y maná (azul) sobre la cabeza del jugador local
  buildLocalBars() {
    const hpBg = this.add.rectangle(0, 0, 32, 5, 0x000000).setOrigin(0.5);
    const hpBar = this.add.rectangle(0, 0, 32, 3, 0x00e676).setOrigin(0, 0.5);
    const mpBg = this.add.rectangle(0, 0, 32, 5, 0x000000).setOrigin(0.5);
    const mpBar = this.add.rectangle(0, 0, 32, 3, 0x2979ff).setOrigin(0, 0.5);

    this.localBars = { hpBg, hpBar, mpBg, mpBar };
  }

  updateLocalBars() {
    if (!this.player || !this.localBars || !this.playerStats) return;

    const { hpBg, hpBar, mpBg, mpBar } = this.localBars;
    const { hpCurrent, hpMax, mpCurrent, mpMax } = this.playerStats;
    const { x, y } = this.player;

    // Con etiqueta de clan el nombre sube: las barras suben con él
    const lift = this.localLabelOffset;

    hpBg.setPosition(x, y - 40 - lift);
    hpBar.setPosition(x - 16, y - 40 - lift);
    mpBg.setPosition(x, y - 34 - lift);
    mpBar.setPosition(x - 16, y - 34 - lift);

    const hpPct = hpMax > 0 ? Phaser.Math.Clamp(hpCurrent / hpMax, 0, 1) : 0;
    const mpPct = mpMax > 0 ? Phaser.Math.Clamp(mpCurrent / mpMax, 0, 1) : 0;

    hpBar.width = 32 * hpPct;
    mpBar.width = 32 * mpPct;
  }
  // Lanza la habilidad de la clase apuntando al cursor. El servidor decide si se
  // puede lanzar (maná, recarga, distancia): aquí solo se manda el punto.
  castSkill(pointer) {
    if (!this.player || this.isChatting) return;

    const aim = pointer || this.input.activePointer;
    const targetX = aim.worldX;
    const targetY = aim.worldY;

    // Si el cursor está encima de un monstruo, se apunta a él explícitamente
    const aimed = this.monsterNear(targetX, targetY);
    const needsTarget = this.skillInfo && this.skillInfo.kind === 'blink';

    this.cancelLogoutIfPending();
    this.socket.emit('castSkill', {
      skillId: this.skillInfo ? this.skillInfo.id : null,
      targetX,
      targetY,
      targetEntityId: needsTarget && aimed ? aimed.id : null
    });
  }

  // Monstruo cuyo sprite cae cerca del punto indicado, o null
  monsterNear(x, y) {
    let found = null;
    let closest = 24;

    this.monstersGroup.forEach((monsterData, id) => {
      const distance = Phaser.Math.Distance.Between(
        x,
        y,
        monsterData.sprite.x,
        monsterData.sprite.y
      );

      if (distance <= closest) {
        closest = distance;
        found = { id, sprite: monsterData.sprite };
      }
    });

    return found;
  }

  addProjectile(data) {
    const texture = data.kind === 'arrow' ? 'proj_arrow' : 'proj_arcane';
    const sprite = this.add.sprite(data.x, data.y, texture).setDepth(20);
    sprite.rotation = Math.atan2(data.dirY, data.dirX);

    // Rastro de chispas que sigue al proyectil mientras vuela
    const trail = this.add.particles(0, 0, 'proj_spark', {
      lifespan: 260,
      speed: { min: 0, max: 20 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.9, end: 0 },
      quantity: 1,
      frequency: 25,
      blendMode: 'ADD'
    }).setDepth(19);

    trail.startFollow(sprite);

    this.projectiles.set(data.id, {
      sprite,
      trail,
      targetX: data.x,
      targetY: data.y
    });
  }

  // Desliza cada proyectil hacia la última posición confirmada por el servidor:
  // así el vuelo se ve continuo aunque la simulación vaya a 20 pasos por segundo
  updateProjectiles(delta) {
    if (!this.projectiles || this.projectiles.size === 0) return;

    const smooth = Math.min(1, delta / 50);

    this.projectiles.forEach((projectile) => {
      projectile.sprite.x = Phaser.Math.Linear(projectile.sprite.x, projectile.targetX, smooth);
      projectile.sprite.y = Phaser.Math.Linear(projectile.sprite.y, projectile.targetY, smooth);
    });
  }

  removeProjectile(data) {
    const projectile = this.projectiles.get(data.id);
    if (!projectile) return;

    this.projectiles.delete(data.id);
    projectile.trail.destroy();

    // Se apagó sin tocar nada: solo se desvanece
    if (!data.hit) {
      this.tweens.add({
        targets: projectile.sprite,
        alpha: 0,
        scale: 0.4,
        duration: 120,
        onComplete: () => projectile.sprite.destroy()
      });
      return;
    }

    projectile.sprite.destroy();
    this.playImpact(data.x, data.y, data.kind, data.targetType === 'player');
  }

  // Destello del impacto, del color de la habilidad que lo provocó
  playImpact(x, y, kind, onPlayer) {
    const tint = onPlayer ? 0xff5252 : (kind === 'arrow' ? 0xffe082 : 0x64b5f6);

    const burst = this.add.particles(x, y, 'proj_spark', {
      lifespan: 300,
      speed: { min: 30, max: 90 },
      scale: { start: 1.2, end: 0 },
      alpha: { start: 1, end: 0 },
      tint,
      emitting: false,
      blendMode: 'ADD'
    }).setDepth(21);

    burst.explode(8);
    this.time.delayedCall(400, () => burst.destroy());
  }

  // Corte Vorpal: abanico dorado hacia donde se apuntó
  playSkillArc(data) {
    const halfAngle = Math.PI / 3;
    const graphics = this.add.graphics().setPosition(data.x, data.y).setDepth(21);

    graphics.fillStyle(0xffd700, 0.25);
    graphics.slice(0, 0, data.range, data.angle - halfAngle, data.angle + halfAngle, false);
    graphics.fillPath();

    graphics.lineStyle(3, 0xffecb3, 0.9);
    graphics.beginPath();
    graphics.arc(0, 0, data.range, data.angle - halfAngle, data.angle + halfAngle, false);
    graphics.strokePath();

    this.tweens.add({
      targets: graphics,
      alpha: 0,
      duration: 280,
      ease: 'Power1',
      onComplete: () => graphics.destroy()
    });
  }

  // Ataque Sombrío: estela en el origen y salto a la posición nueva
  playSkillBlink(data) {
    const ghost = this.add.sprite(data.fromX, data.fromY, 'player')
      .setTint(0x6a1b9a)
      .setAlpha(0.7)
      .setDepth(9);

    this.tweens.add({
      targets: ghost,
      alpha: 0,
      duration: 320,
      onComplete: () => ghost.destroy()
    });

    this.movePlayerTo(data);
  }

  // Coloca a un jugador donde manda el servidor: teletransporte o derribo
  movePlayerTo(data) {
    const target = this.findPlayerById(data.playerId);
    if (!target) return;

    target.setPosition(data.x, data.y);
    this.placeOverheadLabels(target);

    // Solo el derribo trae vida y maná nuevos
    if (target === this.player && data.hpCurrent !== undefined) {
      this.playerStats = { ...(this.playerStats || {}), ...data };
      this.updateLocalBars();
    }
  }

  findPlayerById(playerId) {
    if (this.player && this.player.playerId === playerId) return this.player;

    return this.otherPlayers.getChildren().find(
      (otherPlayer) => otherPlayer.playerId === playerId
    ) || null;
  }

  // Daño recibido por un jugador: número flotante y barra al día
  showPlayerDamage(data) {
    const target = this.findPlayerById(data.playerId);
    if (!target) return;

    this.showDamageText(target.x, target.y, data.damage);

    if (target === this.player) {
      this.playerStats = {
        ...(this.playerStats || {}),
        hpCurrent: data.hpCurrent,
        hpMax: data.hpMax
      };
      this.updateLocalBars();
    }
  }

  findPlayerByCharacterId(characterId) {
    if (!characterId) return null;
    if (this.player && this.player.characterId === characterId) return this.player;

    return this.otherPlayers.getChildren().find(
      (otherPlayer) => otherPlayer.characterId === characterId
    ) || null;
  }

  showLevelUpText(target) {
    const levelUpText = this.add.text(target.x, target.y - 55, '¡NIVEL SUBIDO!', {
      fontSize: '16px',
      fill: '#ffd700',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5).setDepth(100);

    // Animación flotante ascendente dorada
    this.tweens.add({
      targets: levelUpText,
      y: target.y - 90,
      alpha: 0,
      duration: 1500,
      ease: 'Power1',
      onComplete: () => levelUpText.destroy()
    });
  }

  playLevelUpFlash(target) {
    // Destello dorado sobre el sprite
    this.tweens.add({
      targets: target,
      tint: 0xffd700,
      duration: 150,
      yoyo: true,
      repeat: 3,
      onComplete: () => target.setTint(target.baseTint)
    });

    // Pulso de escala
    this.tweens.add({
      targets: target,
      scaleX: 1.35,
      scaleY: 1.35,
      duration: 200,
      yoyo: true,
      ease: 'Quad.easeOut'
    });
  }

  // NPC del mundo (Módulo E). El clic sobre él o la tecla de tienda abren el
  // panel, pero solo si el jugador está cerca: el servidor lo revalida igual.
  addNpc(npc) {
    const sprite = this.add.sprite(npc.x, npc.y, 'merchant').setDepth(4);
    sprite.npcId = npc.id;
    sprite.setInteractive({ useHandCursor: true });
    sprite.on('pointerdown', () => this.toggleShop());

    const label = this.add.text(npc.x, npc.y - 26, `[${npc.name}]`, {
      fontSize: '11px',
      fill: '#ffd700',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2
    }).setOrigin(0.5);

    this.npcSprites.set(npc.id, { sprite, label });
  }

  addWorldDrop(drop) {
    const sprite = this.add.sprite(drop.x, drop.y, drop.spriteId).setDepth(5);
    sprite.dropId = drop.dropId;
    sprite.itemName = drop.name;
    this.worldDropSprites.set(drop.dropId, sprite);

    // Movimiento flotante suave
    this.tweens.add({
      targets: sprite,
      y: drop.y - 5,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Destello continuo
    this.tweens.add({
      targets: sprite,
      alpha: 0.55,
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
  }

  removeWorldDrop(dropId) {
    const sprite = this.worldDropSprites.get(dropId);
    if (!sprite) return;

    this.tweens.killTweensOf(sprite);
    sprite.destroy();
    this.worldDropSprites.delete(dropId);
  }

  pickUpNearestDrop() {
    let nearestDropId = null;
    let nearestDistance = Infinity;

    this.worldDropSprites.forEach((sprite, dropId) => {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, sprite.x, sprite.y);

      if (distance <= PICKUP_RANGE && distance < nearestDistance) {
        nearestDistance = distance;
        nearestDropId = dropId;
      }
    });

    if (nearestDropId) {
      this.socket.emit('pickUpItem', { dropId: nearestDropId });
    }
  }

  // NPC más cercano dentro del rango de comercio, o null si no hay ninguno
  nearestNpcInRange() {
    if (!this.player) return null;

    let nearest = null;
    let nearestDistance = Infinity;

    this.npcSprites.forEach((npc) => {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, npc.sprite.x, npc.sprite.y);

      if (distance <= SHOP_RANGE && distance < nearestDistance) {
        nearestDistance = distance;
        nearest = npc;
      }
    });

    return nearest;
  }

  toggleShop() {
    // Comerciar exige estar junto al comerciante
    if (!this.nearestNpcInRange()) {
      this.appendChatMessage({
        sender: 'SISTEMA',
        text: 'No hay ningún comerciante cerca.',
        color: '#ff5252'
      });
      return;
    }

    if (this.shopWindow.toggle()) this.closeOtherWindows('shop');
  }

  toggleChat() {
    const chatInput = document.getElementById('chat-input');
    if (!chatInput) return;

    if (!this.isChatting) {
      this.isChatting = true;
      chatInput.style.display = 'block';
      chatInput.focus();

      // Detener personaje y pausar escucha de teclado en Phaser
      if (this.player) this.player.setVelocity(0);
      this.input.keyboard.resetKeys();
      this.input.keyboard.enabled = false;
    } else {
      const msg = chatInput.value.trim();
      if (msg) {
        this.socket.emit('sendChatMessage', msg);
      }
      chatInput.value = '';
      chatInput.style.display = 'none';
      this.isChatting = false;

      // Reactivar teclado en Phaser para el movimiento
      this.input.keyboard.enabled = true;
    }
  }

  showSpeechBubble(targetSprite, text) {
    if (targetSprite.speechBubble) targetSprite.speechBubble.destroy();

    targetSprite.speechBubble = this.add.text(
      targetSprite.x,
      targetSprite.y - 42,
      text,
      {
        fontSize: '11px',
        fill: '#000000',
        backgroundColor: '#ffffff',
        padding: { x: 6, y: 3 },
        fontStyle: 'bold'
      }
    ).setOrigin(0.5);

    this.time.delayedCall(4000, () => {
      if (targetSprite.speechBubble) {
        targetSprite.speechBubble.destroy();
        targetSprite.speechBubble = null;
      }
    });
  }

  appendChatMessage(data) {
    const chatLogs = document.getElementById('chat-logs');
    if (!chatLogs) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';
    msgDiv.style.color = data.color || '#ffffff';
    msgDiv.innerHTML = `<strong>${data.sender}:</strong> ${data.text}`;

    chatLogs.appendChild(msgDiv);
    chatLogs.scrollTop = chatLogs.scrollHeight;
  }

  update(time, delta) {
    // Proyectiles y barras siguen vivos aunque el jugador no pueda moverse
    this.updateProjectiles(delta);
    this.updateLocalBars();

    if (!this.player || this.isChatting) return;

    // Mientras se reasigna un control el personaje no debe andar solo
    if (this.settingsWindow.isCapturingKey) {
      this.player.setVelocity(0);
      return;
    }

    let moved = false;
    this.player.setVelocity(0);

    if (this.cursors.left.isDown || this.wasd.left.isDown) {
      this.player.setVelocityX(-this.speed);
      moved = true;
    } else if (this.cursors.right.isDown || this.wasd.right.isDown) {
      this.player.setVelocityX(this.speed);
      moved = true;
    }

    if (this.cursors.up.isDown || this.wasd.up.isDown) {
      this.player.setVelocityY(-this.speed);
      moved = true;
    } else if (this.cursors.down.isDown || this.wasd.down.isDown) {
      this.player.setVelocityY(this.speed);
      moved = true;
    }

    this.player.body.velocity.normalize().scale(this.speed);
    this.placeOverheadLabels(this.player);

    if (this.player.speechBubble) {
      this.player.speechBubble.setPosition(this.player.x, this.player.y - 42);
    }

    if (moved) {
      // Moverse cancela cualquier cierre de sesión en curso
      this.cancelLogoutIfPending();

      // El comercio exige cercanía: alejarse del NPC cierra la tienda
      if (this.shopWindow.isOpen && !this.nearestNpcInRange()) {
        this.shopWindow.close();
      }

      this.socket.emit('playerMovement', {
        x: this.player.x,
        y: this.player.y
      });
    }

    // Un portal se activa al pisarlo; el servidor vuelve a comprobar la distancia
    this.checkPortal();
  }
}