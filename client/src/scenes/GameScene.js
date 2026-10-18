import Phaser from 'phaser';
import { io } from 'socket.io-client';
import InventoryWindow from '../ui/InventoryWindow';
import CharacterWindow from '../ui/CharacterWindow';

// Debe coincidir con PICKUP_RANGE del servidor
const PICKUP_RANGE = 40;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.player = null;
    this.otherPlayers = null;
    this.monstersGroup = null;
    this.worldDropSprites = null;
    this.socket = null;
    this.inventoryWindow = null;
    this.characterWindow = null;
    this.playerStats = null;
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

    if (chatInput) {
      // Detener la propagación de teclas para habilitar WASD, espacio y letras en el chat
      ['keydown', 'keyup', 'keypress'].forEach((eventType) => {
        chatInput.addEventListener(eventType, (e) => e.stopPropagation());
      });

      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.toggleChat();
        }
      });
    }

    // 3. Renderizar el Terreno (Grilla 25x20 tiles)
    for (let x = 0; x < 25; x++) {
      for (let y = 0; y < 20; y++) {
        const isStone = (x === 12 || y === 10);
        this.add.image(x * 32 + 16, y * 32 + 16, isStone ? 'stone' : 'grass');
      }
    }

    this.otherPlayers = this.physics.add.group();
    this.monstersGroup = new Map();
    this.worldDropSprites = new Map();

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
          if (otherPlayer.nameText) {
            otherPlayer.nameText.setPosition(playerInfo.x, playerInfo.y - 25);
          }
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
          if (op.speechBubble) op.speechBubble.destroy();
          op.destroy();
        }
      });
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
        this.showDamageText(monsterData.sprite.x, monsterData.sprite.y, data.damage);

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

    // --- Eventos de WebSockets: Inventario ---
    this.socket.on('currentInventory', (items) => {
      this.inventoryWindow.setItems(items);
    });

    this.socket.on('inventoryUpdated', (items) => {
      this.inventoryWindow.setItems(items);
    });

    this.socket.on('playerStatsUpdated', (stats) => {
      this.playerStats = stats;
      this.inventoryWindow.setStats(stats);
      this.characterWindow.setStats(stats);
      this.updateInventoryPlayer(stats.level);
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

    // 5. Configurar Teclado (Movimiento WASD / Flechas)
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D
    });

    // Tecla Enter para alternar el Chat desde el juego
    this.input.keyboard.on('keydown-ENTER', () => {
      if (!this.isChatting) {
        this.toggleChat();
      }
    });

    // Tecla Espacio para Atacar
    this.input.keyboard.on('keydown-SPACE', () => {
      if (!this.isChatting && this.player) {
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
    });

    // Tecla G para recoger el ítem más cercano dentro del rango
    this.input.keyboard.on('keydown-G', () => {
      if (!this.isChatting && this.player) {
        this.pickUpNearestDrop();
      }
    });

    // Tecla I para abrir/cerrar el inventario
    this.input.keyboard.on('keydown-I', () => {
      if (!this.isChatting && this.player) {
        // Los dos paneles se dibujan centrados: solo uno visible a la vez
        if (this.inventoryWindow.toggle()) this.characterWindow.close();
      }
    });

    // Tecla C para abrir/cerrar el panel de personaje
    this.input.keyboard.on('keydown-C', () => {
      if (!this.isChatting && this.player) {
        if (this.characterWindow.toggle()) this.inventoryWindow.close();
      }
    });
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

  addLocalPlayer(playerInfo) {
    this.player = this.physics.add.sprite(playerInfo.x, playerInfo.y, 'player');
    this.player.setCollideWorldBounds(true);
    this.player.playerId = playerInfo.playerId;
    this.player.characterId = playerInfo.characterId;
    this.player.playerName = playerInfo.name;
    this.player.baseTint = 0xffffff;

    this.player.nameText = this.add.text(
      playerInfo.x,
      playerInfo.y - 25,
      `${playerInfo.name} [Niv.${playerInfo.level}]`,
      {
        fontSize: '12px',
        fill: '#ffff00',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3
      }
    ).setOrigin(0.5);
  }

  addOtherPlayer(playerInfo) {
    const otherPlayer = this.physics.add.sprite(playerInfo.x, playerInfo.y, 'player');
    otherPlayer.setTint(0x808080);
    otherPlayer.playerId = playerInfo.playerId;
    otherPlayer.characterId = playerInfo.characterId;
    otherPlayer.playerName = playerInfo.name;
    otherPlayer.baseTint = 0x808080;

    otherPlayer.nameText = this.add.text(
      playerInfo.x,
      playerInfo.y - 25,
      `${playerInfo.name} [Niv.${playerInfo.level}]`,
      {
        fontSize: '12px',
        fill: '#ffffff',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3
      }
    ).setOrigin(0.5);

    this.otherPlayers.add(otherPlayer);
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

  showDamageText(x, y, damage) {
    const dmgText = this.add.text(x, y - 20, `-${damage}`, {
      fontSize: '14px',
      fill: '#ffeb3b',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 3
    }).setOrigin(0.5);

    // Animación flotante de daño
    this.tweens.add({
      targets: dmgText,
      y: y - 45,
      alpha: 0,
      duration: 800,
      ease: 'Power1',
      onComplete: () => dmgText.destroy()
    });
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

  update() {
    if (!this.player || this.isChatting) return;

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
    this.player.nameText.setPosition(this.player.x, this.player.y - 25);

    if (this.player.speechBubble) {
      this.player.speechBubble.setPosition(this.player.x, this.player.y - 42);
    }

    if (moved) {
      this.socket.emit('playerMovement', {
        x: this.player.x,
        y: this.player.y
      });
    }
  }
}