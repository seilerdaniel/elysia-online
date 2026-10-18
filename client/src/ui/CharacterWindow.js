import Phaser from 'phaser';

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 280;
const PANEL_HEIGHT = 292;

const ROW_START_Y = 122;
const ROW_STEP = 28;
const ROW_LABEL_X = 18;
const ROW_VALUE_X = 200;
const ROW_BUTTON_X = 246;
const ROW_BUTTON_SIZE = 22;

const BAR_LABEL_X = 18;
const BAR_START_X = 44;
const BAR_WIDTH = 156;
const BAR_HEIGHT = 10;
const HP_BAR_Y = 244;
const MP_BAR_Y = 268;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_SLOT_BG = 0x1f2833;
const COLOR_BAR_BG = 0x1f2833;
const COLOR_BAR_HP = 0xe53935;
const COLOR_BAR_MP = 0x1e88e5;
const COLOR_GOLD = 0xffd700;
const GOLD = '#ffd700';
const GREY = '#cfd8dc';

// Atributos repartibles, en el orden en que se dibujan
const ATTRIBUTES = [
  { key: 'fuerza', label: 'Fuerza' },
  { key: 'agilidad', label: 'Agilidad' },
  { key: 'inteligencia', label: 'Inteligencia' },
  { key: 'vitalidad', label: 'Vitalidad' }
];

export default class CharacterWindow {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    this.identity = { name: 'Aventurero', characterClass: 'Guerrero' };
    this.stats = null;

    this.isOpen = false;
    this.texts = {};
    this.attributeTexts = {};

    // El panel vive en un Container centrado respecto al lienzo del juego
    this.container = scene.add.container(
      Math.round((scene.scale.width - PANEL_WIDTH) / 2),
      Math.round((scene.scale.height - PANEL_HEIGHT) / 2)
    ).setDepth(200).setVisible(false);

    this.build();

    // Los botones [+] van en la última capa para no quedar bajo el marco
    this.buttonLayer = scene.add.container(0, 0);
    this.container.add(this.buttonLayer);
  }

  // --- Construcción del panel -------------------------------------------------

  build() {
    const frame = this.scene.add.graphics();

    // Fondo oscuro + doble borde dorado
    frame.fillStyle(COLOR_PANEL_BG, 0.94);
    frame.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(3, COLOR_GOLD, 1);
    frame.strokeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(1, COLOR_GOLD, 0.35);
    frame.strokeRect(6, 6, PANEL_WIDTH - 12, PANEL_HEIGHT - 12);

    // Separadores
    frame.lineStyle(1, COLOR_GOLD, 0.3);
    frame.lineBetween(14, 84, PANEL_WIDTH - 14, 84);
    frame.lineBetween(14, 228, PANEL_WIDTH - 14, 228);

    this.container.add(frame);

    const title = this.scene.add.text(PANEL_WIDTH / 2, 20, 'PERSONAJE', {
      fontSize: '14px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0.5);

    this.texts.name = this.scene.add.text(ROW_LABEL_X, 48, '', {
      fontSize: '13px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.texts.classLevel = this.scene.add.text(ROW_LABEL_X, 68, '', {
      fontSize: '11px', fill: GREY
    }).setOrigin(0, 0.5);

    this.texts.points = this.scene.add.text(ROW_LABEL_X, 98, '', {
      fontSize: '11px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.container.add([title, this.texts.name, this.texts.classLevel, this.texts.points]);

    // Filas de atributos
    ATTRIBUTES.forEach((attribute, index) => {
      const y = ROW_START_Y + index * ROW_STEP;

      const label = this.scene.add.text(ROW_LABEL_X, y, attribute.label, {
        fontSize: '11px', fill: GREY
      }).setOrigin(0, 0.5);

      const value = this.scene.add.text(ROW_VALUE_X, y, '-', {
        fontSize: '12px', fill: '#ffffff', fontStyle: 'bold'
      }).setOrigin(1, 0.5);

      this.attributeTexts[attribute.key] = value;
      this.container.add([label, value]);
    });

    // Barras de estado
    this.bars = this.scene.add.graphics();
    this.container.add(this.bars);

    const hpLabel = this.scene.add.text(BAR_LABEL_X, HP_BAR_Y, 'HP', {
      fontSize: '11px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    const mpLabel = this.scene.add.text(BAR_LABEL_X, MP_BAR_Y, 'MP', {
      fontSize: '11px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.texts.hp = this.scene.add.text(PANEL_WIDTH - 14, HP_BAR_Y, '', {
      fontSize: '11px', fill: GREY
    }).setOrigin(1, 0.5);

    this.texts.mp = this.scene.add.text(PANEL_WIDTH - 14, MP_BAR_Y, '', {
      fontSize: '11px', fill: GREY
    }).setOrigin(1, 0.5);

    this.container.add([hpLabel, mpLabel, this.texts.hp, this.texts.mp]);
  }

  // --- API pública ------------------------------------------------------------

  setIdentity({ name, characterClass }) {
    if (name) this.identity.name = name;
    if (characterClass) this.identity.characterClass = characterClass;
    if (this.isOpen) this.refresh();
  }

  setStats(stats) {
    this.stats = stats;
    if (this.isOpen) this.refresh();
  }

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    if (this.isOpen) this.refresh();

    return this.isOpen;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
  }

  // --- Render -----------------------------------------------------------------

  refresh() {
    const stats = this.stats;
    const points = stats ? stats.statPoints : 0;

    this.texts.name.setText(this.identity.name);
    this.texts.classLevel.setText(`${this.identity.characterClass}  •  Nivel ${stats ? stats.level : 1}`);

    this.texts.points.setText(`Puntos disponibles: ${points}`);
    this.texts.points.setColor(points > 0 ? GOLD : GREY);

    ATTRIBUTES.forEach((attribute) => {
      const value = stats ? stats[attribute.key] : null;
      this.attributeTexts[attribute.key].setText(
        value === null || value === undefined ? '-' : String(value)
      );
    });

    const hpCurrent = stats ? stats.hpCurrent : 0;
    const hpMax = stats ? stats.hpMax : 0;
    const mpCurrent = stats ? stats.mpCurrent : 0;
    const mpMax = stats ? stats.mpMax : 0;

    this.texts.hp.setText(`${hpCurrent} / ${hpMax}`);
    this.texts.mp.setText(`${mpCurrent} / ${mpMax}`);

    this.bars.clear();
    this.drawBar(HP_BAR_Y, hpMax > 0 ? hpCurrent / hpMax : 0, COLOR_BAR_HP);
    this.drawBar(MP_BAR_Y, mpMax > 0 ? mpCurrent / mpMax : 0, COLOR_BAR_MP);

    this.refreshButtons(points);
  }

  drawBar(y, ratio, color) {
    const top = y - BAR_HEIGHT / 2;
    const filled = Math.max(0, Math.min(1, ratio)) * BAR_WIDTH;

    this.bars.fillStyle(COLOR_BAR_BG, 1);
    this.bars.fillRect(BAR_START_X, top, BAR_WIDTH, BAR_HEIGHT);

    if (filled > 0) {
      this.bars.fillStyle(color, 1);
      this.bars.fillRect(BAR_START_X, top, filled, BAR_HEIGHT);
    }

    this.bars.lineStyle(1, COLOR_GOLD, 0.5);
    this.bars.strokeRect(BAR_START_X, top, BAR_WIDTH, BAR_HEIGHT);
  }

  // Los botones [+] solo existen mientras queden puntos por repartir
  refreshButtons(points) {
    this.buttonLayer.removeAll(true);

    if (points <= 0) return;

    ATTRIBUTES.forEach((attribute, index) => {
      const y = ROW_START_Y + index * ROW_STEP;

      const box = this.scene.add.graphics();
      box.fillStyle(COLOR_SLOT_BG, 1);
      box.fillRect(ROW_BUTTON_X - ROW_BUTTON_SIZE / 2, y - ROW_BUTTON_SIZE / 2, ROW_BUTTON_SIZE, ROW_BUTTON_SIZE);
      box.lineStyle(1, COLOR_GOLD, 1);
      box.strokeRect(ROW_BUTTON_X - ROW_BUTTON_SIZE / 2, y - ROW_BUTTON_SIZE / 2, ROW_BUTTON_SIZE, ROW_BUTTON_SIZE);

      const label = this.scene.add.text(ROW_BUTTON_X, y, '+', {
        fontSize: '15px', fill: GOLD, fontStyle: 'bold'
      }).setOrigin(0.5);

      // La zona invisible garantiza que el área clicable sea el recuadro completo
      const zone = this.scene.add.zone(ROW_BUTTON_X, y, ROW_BUTTON_SIZE + 2, ROW_BUTTON_SIZE + 2)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      zone.on('pointerover', () => label.setColor('#ffffff'));
      zone.on('pointerout', () => label.setColor(GOLD));
      zone.on('pointerdown', () => this.socket.emit('assignStatPoint', { attribute: attribute.key }));

      this.buttonLayer.add([box, label, zone]);
    });
  }
}
