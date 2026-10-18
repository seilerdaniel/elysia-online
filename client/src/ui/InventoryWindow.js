import Phaser from 'phaser';
import { describeSuffix } from '../config/suffixes';
import { glowTierFor } from '../config/glow';
import { createGlowSprites } from './glow';

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 448;
const PANEL_HEIGHT = 300;
const SLOT_SIZE = 32;
const SLOT_PITCH = 36;

const GRID_COLS = 6;
const GRID_ROWS = 5;

const PAPERDOLL_X = 24;
const PAPERDOLL_LABEL_X = 62;
const PAPERDOLL_START_Y = 48;
const PAPERDOLL_STEP = 40;

const GRID_START_X = 176;
const GRID_START_Y = 48;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_SLOT_BG = 0x1f2833;
const COLOR_GOLD = 0xffd700;
const GOLD = '#ffd700';
const GREY = '#cfd8dc';

// Las 5 ranuras del paperdoll, en el orden en que se dibujan
const PAPERDOLL_SLOTS = [
  { type: 'Casco', label: 'Cabeza' },
  { type: 'Armadura', label: 'Pecho' },
  { type: 'Arma', label: 'Mano Der.' },
  { type: 'Escudo', label: 'Mano Izq.' },
  { type: 'Alas', label: 'Espalda' }
];

export default class InventoryWindow {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    this.items = [];
    this.stats = null;
    this.player = { level: 1, fuerza: 0, agilidad: 0, inteligencia: 0 };

    this.isOpen = false;
    this.tooltip = null;

    // El panel vive en un Container centrado respecto al lienzo del juego
    this.container = scene.add.container(
      Math.round((scene.scale.width - PANEL_WIDTH) / 2),
      Math.round((scene.scale.height - PANEL_HEIGHT) / 2)
    ).setDepth(200).setVisible(false);

    // Las zonas interactivas de las casillas van primero (son invisibles)
    this.zoneLayer = scene.add.container(0, 0);
    this.container.add(this.zoneLayer);

    this.slotZones = [];
    this.build();

    // El itemLayer se añade AL FINAL para dibujarse por encima del marco
    this.itemLayer = scene.add.container(0, 0);
    this.container.add(this.itemLayer);
  }

  // --- Construcción del marco -------------------------------------------------

  build() {
    const frame = this.scene.add.graphics();

    // Fondo oscuro + doble borde dorado
    frame.fillStyle(COLOR_PANEL_BG, 0.94);
    frame.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(3, COLOR_GOLD, 1);
    frame.strokeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(1, COLOR_GOLD, 0.35);
    frame.strokeRect(6, 6, PANEL_WIDTH - 12, PANEL_HEIGHT - 12);

    // Fondos de sección
    frame.fillStyle(0x000000, 0.3);
    frame.fillRect(18, 42, 132, 208);
    frame.fillRect(170, 42, 224, 200);

    this.container.add(frame);

    const title = this.scene.add.text(PANEL_WIDTH / 2, 18, 'INVENTARIO', {
      fontSize: '14px',
      fill: GOLD,
      fontStyle: 'bold'
    }).setOrigin(0.5);
    this.container.add(title);

    const equippedLabel = this.scene.add.text(PAPERDOLL_X, 34, 'EQUIPADO', {
      fontSize: '10px',
      fill: GREY,
      fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    const backpackLabel = this.scene.add.text(GRID_START_X, 34, 'MOCHILA (30)', {
      fontSize: '10px',
      fill: GREY,
      fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.footerText = this.scene.add.text(PAPERDOLL_X, PANEL_HEIGHT - 26, '', {
      fontSize: '11px',
      fill: GREY,
      fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.container.add([equippedLabel, backpackLabel, this.footerText]);

    this.buildPaperdoll();
    this.buildBackpack();
  }

  buildPaperdoll() {
    PAPERDOLL_SLOTS.forEach((slot, index) => {
      const y = PAPERDOLL_START_Y + index * PAPERDOLL_STEP;

      this.drawSlot(PAPERDOLL_X, y);

      const label = this.scene.add.text(PAPERDOLL_LABEL_X, y + SLOT_SIZE / 2, slot.label, {
        fontSize: '10px',
        fill: GREY
      }).setOrigin(0, 0.5);
      this.container.add(label);

      this.createZone({
        x: PAPERDOLL_X,
        y,
        kind: 'paperdoll',
        type: slot.type
      });
    });
  }

  buildBackpack() {
    for (let slotIndex = 0; slotIndex < GRID_COLS * GRID_ROWS; slotIndex++) {
      const col = slotIndex % GRID_COLS;
      const row = Math.floor(slotIndex / GRID_COLS);
      const x = GRID_START_X + col * SLOT_PITCH;
      const y = GRID_START_Y + row * SLOT_PITCH;

      this.drawSlot(x, y);

      this.createZone({ x, y, kind: 'grid', slotIndex });
    }
  }

  drawSlot(x, y) {
    const slotGraphics = this.scene.add.graphics();
    slotGraphics.fillStyle(COLOR_SLOT_BG, 1);
    slotGraphics.fillRect(x, y, SLOT_SIZE, SLOT_SIZE);
    slotGraphics.lineStyle(1, COLOR_GOLD, 0.4);
    slotGraphics.strokeRect(x, y, SLOT_SIZE, SLOT_SIZE);

    this.container.add(slotGraphics);
  }

  createZone(meta) {
    const zone = this.scene.add.zone(
      meta.x + SLOT_SIZE / 2,
      meta.y + SLOT_SIZE / 2,
      SLOT_SIZE,
      SLOT_SIZE
    ).setOrigin(0.5).setInteractive({ useHandCursor: true });

    zone.slotMeta = meta;
    zone.slotX = meta.x;
    zone.slotY = meta.y;

    zone.on('pointerover', () => this.onSlotOver(zone));
    zone.on('pointerout', () => this.hideTooltip());
    // Clic izquierdo y derecho hacen la misma acción
    zone.on('pointerdown', () => this.onSlotClick(zone));

    this.zoneLayer.add(zone);
    this.slotZones.push(zone);
  }

  // --- API pública ------------------------------------------------------------

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    // El contenido de las casillas cambió: el tooltip anterior ya no es válido
    this.hideTooltip();
    if (this.isOpen) this.render();
  }

  setStats(stats) {
    this.stats = stats;
    this.updateFooter();
    if (this.isOpen) this.render();
  }

  setPlayer({ level, fuerza, agilidad, inteligencia }) {
    this.player = {
      level: level || 1,
      fuerza: fuerza || 0,
      agilidad: agilidad || 0,
      inteligencia: inteligencia || 0
    };
  }

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    if (!this.isOpen) this.hideTooltip();
    else this.render();

    return this.isOpen;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
    this.hideTooltip();
  }

  // --- Render -----------------------------------------------------------------

  findItemForZone(zone) {
    const meta = zone.slotMeta;

    if (meta.kind === 'grid') {
      return this.items.find((item) => !item.isEquipped && item.slotIndex === meta.slotIndex) || null;
    }

    return this.items.find((item) => item.isEquipped && item.type === meta.type) || null;
  }

  render() {
    this.itemLayer.removeAll(true);

    this.slotZones.forEach((zone) => {
      const item = this.findItemForZone(zone);
      if (!item) return;

      if (!this.scene.textures.exists(item.spriteId)) return;

      const centerX = zone.slotX + SLOT_SIZE / 2;
      const centerY = zone.slotY + SLOT_SIZE / 2;

      // Aura de la forja: el brillo va detrás del ítem, así que se añade antes
      createGlowSprites(this.scene, centerX, centerY, item.spriteId, glowTierFor(item.enhanceLevel), 24)
        .forEach((aura) => this.itemLayer.add(aura));

      const sprite = this.scene.add.sprite(centerX, centerY, item.spriteId).setDisplaySize(24, 24);

      // Marca de mejora (+1 a +15)
      if (item.enhanceLevel > 0) {
        const enhanceText = this.scene.add.text(
          zone.slotX + SLOT_SIZE - 2,
          zone.slotY + SLOT_SIZE - 2,
          `+${item.enhanceLevel}`,
          { fontSize: '9px', fill: GOLD, fontStyle: 'bold' }
        ).setOrigin(1, 1);
        this.itemLayer.add(enhanceText);
      }

      this.itemLayer.add(sprite);
    });

    this.updateFooter();
  }

  updateFooter() {
    if (!this.stats) {
      this.footerText.setText('');
      return;
    }

    this.footerText.setText(
      `HP ${this.stats.hpCurrent}/${this.stats.hpMax}    MP ${this.stats.mpCurrent}/${this.stats.mpMax}    Oro ${this.stats.gold}`
    );
  }

  // --- Tooltip ----------------------------------------------------------------

  onSlotOver(zone) {
    const item = this.findItemForZone(zone);
    if (!item) return;

    this.showTooltip(
      item,
      this.container.x + zone.slotX,
      this.container.y + zone.slotY
    );
  }

  // El daño y la defensa que se enseñan son los que el ítem hace HOY: el servidor
  // ya los manda multiplicados por la forja. Entre paréntesis va el valor de
  // fábrica, para que se vea de un vistazo lo que aportó la mejora.
  describeDamage(item) {
    const stats = item.stats || {};
    const min = Number(stats.damageMin) || 0;
    const max = Number(stats.damageMax) || 0;

    if (min <= 0 && max <= 0) return null;

    return `Daño: ${min}-${max}${this.forgeNote(item)}`;
  }

  describeDefense(item) {
    const valor = Number((item.stats || {}).defense) || 0;

    if (valor <= 0) return null;

    return `Defensa: ${valor}${this.forgeNote(item)}`;
  }

  forgeNote(item) {
    const base = item.baseStats;
    if (!base || Number(item.enhanceLevel) <= 0) return '';

    const partes = [];
    if (Number(base.damageMax) > 0) partes.push(`base ${base.damageMin}-${base.damageMax}`);
    if (Number(base.defense) > 0) partes.push(`base ${base.defense}`);

    return partes.length > 0 ? `  (${partes.join(', ')})` : '';
  }

  buildTooltipLines(item) {
    const nivel = Number(item.enhanceLevel) || 0;

    const lines = [
      {
        text: nivel > 0 ? `${item.name}  +${nivel}` : item.name,
        color: nivel > 0 ? GOLD : GREY
      },
      { text: `Tipo: ${item.type}`, color: GREY }
    ];

    const daño = this.describeDamage(item);
    if (daño) lines.push({ text: daño, color: '#ff8a80' });

    const defensa = this.describeDefense(item);
    if (defensa) lines.push({ text: defensa, color: '#90caf9' });

    if (item.effect) {
      lines.push({ text: `Efecto: +${item.effect.amount} ${item.effect.stat.toUpperCase()}`, color: '#a5d6a7' });
    }

    // Sufijos aleatorios del botín (JSONB). Las claves crudas las traduce
    // describeSuffix: 'daño_critico: 9' se lee mejor como 'Daño crítico +9%'
    Object.entries(item.bonusAttributes || {}).forEach(([key, value]) => {
      lines.push({ text: describeSuffix(key, value), color: '#b39ddb' });
    });

    if (item.equipSlot) {
      const reqs = item.requirements;
      const checks = [
        { label: 'Nivel', required: reqs.level, current: this.player.level },
        { label: 'Fuerza', required: reqs.fuerza, current: this.player.fuerza },
        { label: 'Agilidad', required: reqs.agilidad, current: this.player.agilidad },
        { label: 'Inteligencia', required: reqs.inteligencia, current: this.player.inteligencia }
      ].filter((check) => check.required > 0);

      if (checks.length > 0) {
        lines.push({ text: 'Requisitos:', color: GOLD });
        checks.forEach((check) => {
          const ok = check.current >= check.required;
          lines.push({
            text: `  ${check.label}: ${check.required}`,
            color: ok ? '#a5d6a7' : '#ff5252'
          });
        });
      }
    }

    lines.push({ text: this.describeAction(item), color: '#78909c' });

    return lines;
  }

  describeAction(item) {
    if (item.isEquipped) return 'Clic: desequipar';
    if (item.type === 'Pocion') return 'Clic: consumir';
    if (item.equipSlot) return 'Clic: equipar';
    return 'Sin uso disponible';
  }

  showTooltip(item, anchorX, anchorY) {
    this.hideTooltip();

    const lines = this.buildTooltipLines(item);
    const padding = 8;
    const lineHeight = 15;

    const texts = lines.map((line) => this.scene.add.text(0, 0, line.text, {
      fontSize: '11px',
      fill: line.color,
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2
    }).setDepth(301));

    const width = Math.max(...texts.map((text) => text.width)) + padding * 2;
    const height = texts.length * lineHeight + padding * 2;

    // Posicionar junto a la casilla, sin salirse del lienzo
    let boxX = anchorX + SLOT_SIZE + 6;
    let boxY = anchorY - 4;

    if (boxX + width > this.scene.scale.width - 8) boxX = anchorX - width - 6;
    if (boxY + height > this.scene.scale.height - 8) boxY = this.scene.scale.height - 8 - height;
    if (boxY < 8) boxY = 8;

    const background = this.scene.add.graphics().setDepth(300);
    background.fillStyle(COLOR_PANEL_BG, 0.97);
    background.fillRect(boxX, boxY, width, height);
    background.lineStyle(2, COLOR_GOLD, 1);
    background.strokeRect(boxX, boxY, width, height);

    texts.forEach((text, index) => {
      text.setPosition(boxX + padding, boxY + padding + index * lineHeight);
    });

    this.tooltip = [background, ...texts];
  }

  hideTooltip() {
    if (!this.tooltip) return;

    this.tooltip.forEach((object) => object.destroy());
    this.tooltip = null;
  }

  // --- Acciones ---------------------------------------------------------------

  onSlotClick(zone) {
    const item = this.findItemForZone(zone);
    if (!item) return;

    if (item.isEquipped) {
      this.socket.emit('unequipItem', { itemId: item.id });
      return;
    }

    if (item.type === 'Pocion') {
      this.socket.emit('useItem', { itemId: item.id });
      return;
    }

    if (item.equipSlot) {
      this.socket.emit('equipItem', { itemId: item.id });
    }
  }
}
