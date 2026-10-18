import Phaser from 'phaser';

// Panel de tienda del comerciante (Módulo E). Dos columnas: la mercancía del NPC
// y lo que el jugador puede vender de su mochila. El servidor valida cada
// transacción (distancia, oro, espacio); aquí solo se dibuja y se muestra la
// confirmación que devuelve.

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 468;
const PANEL_HEIGHT = 320;

const MARGIN = 16;
const COLUMN_WIDTH = (PANEL_WIDTH - MARGIN * 3) / 2;
const RIGHT_COLUMN_X = MARGIN * 2 + COLUMN_WIDTH;

const TITLE_Y = 18;
const SECTION_Y = 42;
const LIST_Y = 58;
const ROW_HEIGHT = 24;
const ROWS_PER_PAGE = 9; // 9 * 24 = 216 px de lista hasta el separador

const SEPARATOR_Y = 282;
const NOTICE_Y = 298;

const ROW_ICON_SIZE = 18;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_ROW_BG = 0x1f2833;
const COLOR_ROW_HOVER = 0x2c3b4a;
const COLOR_GOLD = 0xffd700;
const GOLD = '#ffd700';
const GREY = '#cfd8dc';
const WHITE = '#ffffff';
const MUTED = '#78909c';
const UNAFFORDABLE = '#ff5252';
const SUCCESS = '#a5d6a7';
const WARNING = '#ff8a80';

const NOTICE_TTL_MS = 4000;

export default class ShopWindow {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    this.catalog = [];  // mercancía del comerciante
    this.backpack = []; // inventario del jugador (se filtra lo equipado)
    this.stats = null;

    this.isOpen = false;
    this.pages = { buy: 0, sell: 0 };
    this.noticeTimer = null;
    this.columns = {};

    // El panel vive en un Container centrado respecto al lienzo del juego
    this.container = scene.add.container(
      Math.round((scene.scale.width - PANEL_WIDTH) / 2),
      Math.round((scene.scale.height - PANEL_HEIGHT) / 2)
    ).setDepth(200).setVisible(false);

    this.build();
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

    // Separador entre las columnas de comercio y la confirmación
    frame.lineStyle(1, COLOR_GOLD, 0.3);
    frame.lineBetween(MARGIN, SEPARATOR_Y, PANEL_WIDTH - MARGIN, SEPARATOR_Y);

    this.container.add(frame);

    const title = this.scene.add.text(MARGIN, TITLE_Y, 'TIENDA DEL COMERCIANTE', {
      fontSize: '13px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    // La bolsa de oro se refresca con cada playerStatsUpdated
    this.goldText = this.scene.add.text(PANEL_WIDTH - MARGIN, TITLE_Y, 'Oro: —', {
      fontSize: '12px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    this.noticeText = this.scene.add.text(PANEL_WIDTH / 2, NOTICE_Y, '', {
      fontSize: '11px',
      fill: GREY,
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: PANEL_WIDTH - MARGIN * 2 }
    }).setOrigin(0.5);

    this.container.add([title, this.goldText, this.noticeText]);

    this.buildColumn('buy', MARGIN, 'COMPRAR');
    this.buildColumn('sell', RIGHT_COLUMN_X, 'VENDER');
  }

  buildColumn(id, x, label) {
    const title = this.scene.add.text(x + 4, SECTION_Y, label, {
      fontSize: '10px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    const pageText = this.scene.add.text(x + COLUMN_WIDTH - 24, SECTION_Y, '', {
      fontSize: '10px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    const prev = this.buildPageArrow(x + COLUMN_WIDTH - 58, SECTION_Y, '◀', () => this.changePage(id, -1));
    const next = this.buildPageArrow(x + COLUMN_WIDTH - 6, SECTION_Y, '▶', () => this.changePage(id, 1));

    // Las filas se reconstruyen enteras en cada refresco
    const rows = this.scene.add.container(0, 0);

    this.container.add([title, pageText, prev, next, rows]);

    this.columns[id] = { x, rows, pageText, prev, next };
  }

  buildPageArrow(x, y, glyph, onClick) {
    const arrow = this.scene.add.text(x, y, glyph, {
      fontSize: '11px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    arrow.on('pointerover', () => arrow.setColor(WHITE));
    arrow.on('pointerout', () => arrow.setColor(GOLD));
    arrow.on('pointerdown', onClick);

    return arrow;
  }

  // --- API pública ------------------------------------------------------------

  setCatalog(catalog) {
    this.catalog = Array.isArray(catalog) ? catalog : [];
    if (this.isOpen) this.renderColumn('buy');
  }

  setBackpack(items) {
    this.backpack = Array.isArray(items) ? items : [];
    if (this.isOpen) this.renderColumn('sell');
  }

  setStats(stats) {
    this.stats = stats;
    this.updateGold();

    // El oro decide qué se puede pagar: los precios cambian de color
    if (this.isOpen) this.renderColumn('buy');
  }

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    if (this.isOpen) this.render();

    return this.isOpen;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
    this.clearNotice();
  }

  // Confirmación de la última transacción: la decide el servidor
  showResult(result) {
    if (!result) return;

    this.showNotice(result.text, result.ok ? SUCCESS : WARNING);
  }

  // --- Render -----------------------------------------------------------------

  render() {
    this.updateGold();
    this.renderColumn('buy');
    this.renderColumn('sell');
  }

  updateGold() {
    this.goldText.setText(this.stats ? `Oro: ${this.stats.gold}` : 'Oro: —');
  }

  changePage(id, delta) {
    const pages = this.pageCount(id);
    if (pages <= 1) return;

    // Da la vuelta: con la mochila llena siempre se llega a cualquier ítem
    this.pages[id] = (this.pages[id] + delta + pages) % pages;
    this.renderColumn(id);
  }

  pageCount(id) {
    return Math.max(1, Math.ceil(this.entriesFor(id).length / ROWS_PER_PAGE));
  }

  // Filas normalizadas: el render es el mismo para las dos columnas
  entriesFor(id) {
    if (id === 'buy') {
      const gold = this.stats ? this.stats.gold : 0;

      return this.catalog.map((entry) => ({
        name: entry.name,
        spriteId: entry.spriteId,
        price: entry.price,
        unaffordable: this.stats ? gold < entry.price : false,
        onClick: () => this.socket.emit('buyItem', { itemTemplateId: entry.templateId })
      }));
    }

    return this.backpack
      // Lo equipado no se vende (y no ocupa casillero) y lo que no tiene precio no se puede tasar
      .filter((item) => !item.isEquipped && item.salePrice > 0)
      .map((item) => ({
        name: item.name,
        spriteId: item.spriteId,
        price: item.salePrice,
        unaffordable: false,
        onClick: () => this.socket.emit('sellItem', { itemId: item.id })
      }));
  }

  renderColumn(id) {
    const column = this.columns[id];
    const entries = this.entriesFor(id);
    const pages = Math.max(1, Math.ceil(entries.length / ROWS_PER_PAGE));

    // Vender abarata la mochila: la página actual puede quedarse fuera
    if (this.pages[id] > pages - 1) this.pages[id] = pages - 1;

    column.rows.removeAll(true);

    const hasPages = pages > 1;
    column.prev.setVisible(hasPages);
    column.next.setVisible(hasPages);
    column.pageText.setText(hasPages ? `${this.pages[id] + 1}/${pages}` : '');

    const start = this.pages[id] * ROWS_PER_PAGE;
    const visible = entries.slice(start, start + ROWS_PER_PAGE);

    if (visible.length === 0) {
      const empty = this.scene.add.text(
        column.x + 4,
        LIST_Y + 10,
        id === 'buy' ? 'El comerciante no tiene mercancía.' : 'No tienes nada que vender.',
        { fontSize: '11px', fill: MUTED }
      ).setOrigin(0, 0.5);

      column.rows.add(empty);
      return;
    }

    visible.forEach((entry, index) => {
      this.buildRow(column, LIST_Y + index * ROW_HEIGHT, entry);
    });
  }

  buildRow(column, y, entry) {
    const centerY = y + ROW_HEIGHT / 2 - 1;

    const background = this.scene.add.rectangle(
      column.x + COLUMN_WIDTH / 2,
      centerY,
      COLUMN_WIDTH,
      ROW_HEIGHT - 2,
      COLOR_ROW_BG,
      1
    );

    const name = this.scene.add.text(column.x + 28, centerY, entry.name, {
      fontSize: '11px', fill: GREY
    }).setOrigin(0, 0.5);

    const price = this.scene.add.text(column.x + COLUMN_WIDTH - 6, centerY, `${entry.price} oro`, {
      fontSize: '11px',
      fill: entry.unaffordable ? UNAFFORDABLE : GOLD,
      fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    const objects = [background];

    if (this.scene.textures.exists(entry.spriteId)) {
      objects.push(
        this.scene.add.sprite(column.x + 14, centerY, entry.spriteId)
          .setDisplaySize(ROW_ICON_SIZE, ROW_ICON_SIZE)
      );
    }

    objects.push(name, price);

    // Toda la fila es clicable: es más fácil acertar que al icono solo
    const zone = this.scene.add.zone(
      column.x + COLUMN_WIDTH / 2,
      centerY,
      COLUMN_WIDTH,
      ROW_HEIGHT
    ).setOrigin(0.5).setInteractive({ useHandCursor: true });

    zone.on('pointerover', () => background.setFillStyle(COLOR_ROW_HOVER));
    zone.on('pointerout', () => background.setFillStyle(COLOR_ROW_BG));
    zone.on('pointerdown', entry.onClick);

    objects.push(zone);
    column.rows.add(objects);
  }

  // --- Avisos -----------------------------------------------------------------

  showNotice(text, color = GREY, ttl = NOTICE_TTL_MS) {
    this.noticeText.setText(text);
    this.noticeText.setColor(color);

    if (this.noticeTimer) {
      this.noticeTimer.remove();
      this.noticeTimer = null;
    }

    if (ttl > 0) {
      this.noticeTimer = this.scene.time.delayedCall(ttl, () => {
        this.noticeTimer = null;
        this.noticeText.setText('');
      });
    }
  }

  // Cerrar la tienda descarta el aviso: al reabrirla no debe aparecer una
  // confirmación vieja de una compra anterior
  clearNotice() {
    if (this.noticeTimer) {
      this.noticeTimer.remove();
      this.noticeTimer = null;
    }

    this.noticeText.setText('');
  }
}
