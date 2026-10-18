import Phaser from 'phaser';

// Panel de forja (Módulo J).
//
// El jugador pone una pieza en el yunque y elige la gema que quiere gastar. El
// servidor contesta con la probabilidad, el coste y qué pasa si falla; el cliente
// no calcula nada de eso, solo pregunta y pinta la respuesta. Por eso la ventana
// no conoce qué gema pide cada tramo: lo dice el servidor en su mensaje.

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 480;
const PANEL_HEIGHT = 324;
const MARGIN = 16;

const TITLE_Y = 18;

const SLOT_SIZE = 56;
const SLOT_Y = 40;
const ITEM_SLOT_X = MARGIN;
const GEM_SLOT_X = MARGIN + SLOT_SIZE + 28;
const SLOT_LABEL_Y = SLOT_Y + SLOT_SIZE + 8;

const INFO_X = 180;
const INFO_WIDTH = PANEL_WIDTH - INFO_X - MARGIN;
const ITEM_NAME_Y = 44;
const ITEM_STATS_Y = 62;

const PLAN_Y = 84;
const PLAN_DETAIL_Y = 102;

const BUTTON_X = 180;
const BUTTON_Y = 120;
const BUTTON_WIDTH = PANEL_WIDTH - BUTTON_X - MARGIN;
const BUTTON_HEIGHT = 28;

const SEPARATOR_Y = 158;

const CHIP_SIZE = 36;
const CHIP_PITCH = 46;
const CHIPS_PER_ROW = 9;
const ITEMS_LABEL_Y = 168;
const ITEMS_Y = 180;
const GEMS_LABEL_Y = 224;
const GEMS_Y = 236;

const HINT_Y = 286;
const NOTICE_Y = 306;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_SLOT_BG = 0x1f2833;
const COLOR_SLOT_HOVER = 0x2c3b4a;
const COLOR_GOLD = 0xffd700;
const COLOR_GOLD_DIM = 0x7a6420;
const GOLD = '#ffd700';
const GREY = '#cfd8dc';
const MUTED = '#78909c';
const SUCCESS = '#a5d6a7';
const WARNING = '#ff8a80';
const DANGER = '#ff5252';

const NOTICE_TTL_MS = 5000;
const PENDING_TIMEOUT_MS = 4000;

export default class ForgeWindow {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    this.items = [];      // último inventario recibido
    this.stats = null;

    this.selectedItemId = null;
    this.selectedGemId = null;
    this.plan = null;     // respuesta del servidor al último requestForgeInfo

    this.isOpen = false;
    this.pending = false; // hay un intento en vuelo: el botón no se repite
    this.pendingTimer = null;
    this.noticeTimer = null;

    this.container = scene.add.container(
      Math.round((scene.scale.width - PANEL_WIDTH) / 2),
      Math.round((scene.scale.height - PANEL_HEIGHT) / 2)
    ).setDepth(200).setVisible(false);

    this.build();
  }

  // --- Construcción del panel -------------------------------------------------

  build() {
    const frame = this.scene.add.graphics();

    frame.fillStyle(COLOR_PANEL_BG, 0.94);
    frame.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(3, COLOR_GOLD, 1);
    frame.strokeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(1, COLOR_GOLD, 0.35);
    frame.strokeRect(6, 6, PANEL_WIDTH - 12, PANEL_HEIGHT - 12);

    frame.lineStyle(1, COLOR_GOLD, 0.3);
    frame.lineBetween(MARGIN, SEPARATOR_Y, PANEL_WIDTH - MARGIN, SEPARATOR_Y);

    // Fondos de las dos casillas del yunque
    frame.fillStyle(COLOR_SLOT_BG, 1);
    frame.fillRect(ITEM_SLOT_X, SLOT_Y, SLOT_SIZE, SLOT_SIZE);
    frame.fillRect(GEM_SLOT_X, SLOT_Y, SLOT_SIZE, SLOT_SIZE);
    frame.lineStyle(1, COLOR_GOLD, 0.4);
    frame.strokeRect(ITEM_SLOT_X, SLOT_Y, SLOT_SIZE, SLOT_SIZE);
    frame.strokeRect(GEM_SLOT_X, SLOT_Y, SLOT_SIZE, SLOT_SIZE);

    this.container.add(frame);

    const title = this.scene.add.text(MARGIN, TITLE_Y, 'FORJA', {
      fontSize: '13px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.goldText = this.scene.add.text(PANEL_WIDTH - MARGIN, TITLE_Y, 'Oro: —', {
      fontSize: '12px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    this.itemNameText = this.scene.add.text(INFO_X, ITEM_NAME_Y, 'Sin pieza', {
      fontSize: '12px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.itemStatsText = this.scene.add.text(INFO_X, ITEM_STATS_Y, '', {
      fontSize: '11px', fill: GREY
    }).setOrigin(0, 0.5);

    this.successText = this.scene.add.text(INFO_X, PLAN_Y, '', {
      fontSize: '12px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.costText = this.scene.add.text(PANEL_WIDTH - MARGIN, PLAN_Y, '', {
      fontSize: '12px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    this.planDetailText = this.scene.add.text(INFO_X, PLAN_DETAIL_Y, '', {
      fontSize: '11px',
      fill: MUTED,
      wordWrap: { width: INFO_WIDTH }
    }).setOrigin(0, 0.5);

    this.itemsLabel = this.scene.add.text(MARGIN, ITEMS_LABEL_Y, 'TU EQUIPO', {
      fontSize: '10px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.gemsLabel = this.scene.add.text(MARGIN, GEMS_LABEL_Y, 'GEMAS', {
      fontSize: '10px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.hintText = this.scene.add.text(PANEL_WIDTH / 2, HINT_Y, '', {
      fontSize: '11px',
      fill: MUTED,
      align: 'center',
      wordWrap: { width: PANEL_WIDTH - MARGIN * 2 }
    }).setOrigin(0.5);

    this.noticeText = this.scene.add.text(PANEL_WIDTH / 2, NOTICE_Y, '', {
      fontSize: '12px',
      fill: GREY,
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: PANEL_WIDTH - MARGIN * 2 }
    }).setOrigin(0.5);

    this.container.add([
      title,
      this.goldText,
      this.itemNameText,
      this.itemStatsText,
      this.successText,
      this.costText,
      this.planDetailText,
      this.itemsLabel,
      this.gemsLabel,
      this.hintText,
      this.noticeText
    ]);

    // Capas que se vacían en cada refresco
    this.slotLayer = this.scene.add.container(0, 0);
    this.itemsLayer = this.scene.add.container(0, 0);
    this.gemsLayer = this.scene.add.container(0, 0);

    this.container.add([this.slotLayer, this.itemsLayer, this.gemsLayer]);

    this.buildButton();
    this.buildSlotLabels();
  }

  buildSlotLabels() {
    const itemLabel = this.scene.add.text(ITEM_SLOT_X + 2, SLOT_LABEL_Y, 'PIEZA', {
      fontSize: '9px', fill: MUTED, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    const gemLabel = this.scene.add.text(GEM_SLOT_X + 2, SLOT_LABEL_Y, 'GEMA', {
      fontSize: '9px', fill: MUTED, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.gemNameText = this.scene.add.text(GEM_SLOT_X + 2, SLOT_LABEL_Y + 14, '', {
      fontSize: '10px',
      fill: GREY,
      wordWrap: { width: SLOT_SIZE + 12 }
    }).setOrigin(0, 0);

    this.container.add([itemLabel, gemLabel, this.gemNameText]);
  }

  buildButton() {
    this.buttonBox = this.scene.add.rectangle(
      BUTTON_X + BUTTON_WIDTH / 2,
      BUTTON_Y + BUTTON_HEIGHT / 2,
      BUTTON_WIDTH,
      BUTTON_HEIGHT,
      COLOR_SLOT_BG,
      1
    ).setStrokeStyle(2, COLOR_GOLD_DIM, 1);

    this.buttonText = this.scene.add.text(
      BUTTON_X + BUTTON_WIDTH / 2,
      BUTTON_Y + BUTTON_HEIGHT / 2,
      'FORJAR',
      { fontSize: '13px', fill: MUTED, fontStyle: 'bold' }
    ).setOrigin(0.5);

    this.buttonBox.setInteractive({ useHandCursor: true });
    this.buttonBox.on('pointerover', () => this.hoverButton(true));
    this.buttonBox.on('pointerout', () => this.hoverButton(false));
    this.buttonBox.on('pointerdown', () => this.forge());

    this.container.add([this.buttonBox, this.buttonText]);
  }

  // --- API pública ------------------------------------------------------------

  setItems(items) {
    // La gema elegida puede haber desaparecido (se gastó al forjar): si es así se
    // busca otra del mismo tipo, para no obligar a volver a elegirla a cada intento
    const anterior = this.items.find((item) => item.id === this.selectedGemId);
    const nombreGema = anterior ? anterior.name : null;

    this.items = Array.isArray(items) ? items : [];

    if (this.selectedItemId && !this.items.some((item) => item.id === this.selectedItemId)) {
      this.selectedItemId = null;
    }

    if (this.selectedGemId && !this.items.some((item) => item.id === this.selectedGemId)) {
      const recambio = this.items.find((item) => item.type === 'Gema' && item.name === nombreGema);
      this.selectedGemId = recambio ? recambio.id : null;
    }

    if (this.isOpen) {
      this.render();
      this.requestPlan();
    }
  }

  setStats(stats) {
    this.stats = stats;
    this.updateGold();

    if (this.isOpen) this.render();
  }

  setPlan(info) {
    // La respuesta puede llegar de una selección anterior: solo se acepta la que
    // habla de la pieza y la gema que están puestas ahora
    if (!info || info.itemId !== this.selectedItemId || info.gemItemId !== this.selectedGemId) {
      return;
    }

    this.plan = info;
    if (this.isOpen) this.render();
  }

  // Resultado del intento. El texto del chat ya cuenta qué pasó; aquí se enseña el
  // salto de nivel, que es lo que el jugador está mirando en la ventana
  showEnhanced(data) {
    this.clearPending();
    if (!data) return;

    if (data.reason || !Number.isFinite(Number(data.newLevel))) {
      // El servidor ya explicó el motivo por el chat
      this.showNotice('No se pudo forjar.', DANGER);
      this.requestPlan();
      return;
    }

    const salto = `+${data.previousLevel} → +${data.newLevel}`;
    this.showNotice(
      `${data.itemName}  ${salto}`,
      data.success ? SUCCESS : WARNING
    );

    // La gema se gastó y el nivel cambió: el plan viejo ya no sirve
    this.requestPlan();
  }

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    if (!this.isOpen) {
      this.clearNotice();
      return false;
    }

    // Al abrir, la primera pieza forjable queda elegida: se elige la gema y listo
    if (!this.selectedItemId) {
      const primera = this.items.find((item) => item.equipSlot);
      if (primera) this.selectedItemId = primera.id;
    }

    this.render();
    this.requestPlan();

    return true;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
    this.clearNotice();
  }

  // --- Selección --------------------------------------------------------------

  selectItem(itemId) {
    // Volver a pulsar la pieza elegida la suelta
    this.selectedItemId = this.selectedItemId === itemId ? null : itemId;
    this.render();
    this.requestPlan();
  }

  selectGem(gemItemId) {
    this.selectedGemId = this.selectedGemId === gemItemId ? null : gemItemId;
    this.render();
    this.requestPlan();
  }

  requestPlan() {
    this.plan = null;

    if (!this.selectedItemId || !this.selectedGemId) {
      this.render();
      return;
    }

    this.socket.emit('requestForgeInfo', {
      itemId: this.selectedItemId,
      gemItemId: this.selectedGemId
    });
  }

  forge() {
    if (this.pending) return;

    const plan = this.plan;
    if (!plan || !plan.ok) return;

    this.pending = true;
    this.renderButton();

    this.socket.emit('enhanceItem', {
      itemId: plan.itemId,
      gemItemId: plan.gemItemId
    });

    // Si la respuesta nunca llega, el botón no puede quedarse muerto para siempre
    this.pendingTimer = this.scene.time.delayedCall(PENDING_TIMEOUT_MS, () => this.clearPending());
  }

  clearPending() {
    this.pending = false;

    if (this.pendingTimer) {
      this.pendingTimer.remove();
      this.pendingTimer = null;
    }

    if (this.isOpen) this.renderButton();
  }

  // --- Render -----------------------------------------------------------------

  render() {
    this.updateGold();
    this.renderSlots();
    this.renderPlan();
    this.renderItems();
    this.renderGems();
    this.renderButton();
    this.renderHint();
  }

  updateGold() {
    this.goldText.setText(this.stats ? `Oro: ${this.stats.gold}` : 'Oro: —');
  }

  renderSlots() {
    this.slotLayer.removeAll(true);

    const item = this.items.find((entry) => entry.id === this.selectedItemId) || null;
    const gem = this.items.find((entry) => entry.id === this.selectedGemId) || null;

    this.drawSlotContents(ITEM_SLOT_X, SLOT_Y, item);
    this.drawSlotContents(GEM_SLOT_X, SLOT_Y, gem);

    this.gemNameText.setText(gem ? gem.name : '—');
  }

  drawSlotContents(x, y, item) {
    if (!item) return;

    const centerX = x + SLOT_SIZE / 2;
    const centerY = y + SLOT_SIZE / 2;

    if (this.scene.textures.exists(item.spriteId)) {
      this.slotLayer.add(
        this.scene.add.sprite(centerX, centerY, item.spriteId).setDisplaySize(34, 34)
      );
    }

    if (Number(item.enhanceLevel) > 0) {
      this.slotLayer.add(
        this.scene.add.text(x + SLOT_SIZE - 3, y + SLOT_SIZE - 3, `+${item.enhanceLevel}`, {
          fontSize: '11px', fill: GOLD, fontStyle: 'bold', stroke: '#000000', strokeThickness: 3
        }).setOrigin(1, 1)
      );
    }
  }

  renderPlan() {
    const item = this.items.find((entry) => entry.id === this.selectedItemId) || null;
    const plan = this.plan;

    if (!item) {
      this.itemNameText.setText('Sin pieza');
      this.itemStatsText.setText('');
    } else {
      this.itemNameText.setText(
        Number(item.enhanceLevel) > 0 ? `${item.name}  +${item.enhanceLevel}` : item.name
      );
      this.itemStatsText.setText(this.describeStats(item));
    }

    // Sin plan (falta la gema o el servidor aún no contestó) no hay números que dar
    if (!plan) {
      this.successText.setText('');
      this.costText.setText('');
      this.planDetailText.setColor(MUTED);

      if (!this.selectedItemId) {
        this.planDetailText.setText('Elige la pieza que quieres forjar.');
      } else if (!this.selectedGemId) {
        this.planDetailText.setText('Elige la gema que se va a gastar.');
      } else {
        this.planDetailText.setText('Consultando la forja...');
      }

      return;
    }

    // El servidor puede rechazar el intento: su mensaje es el que se enseña
    if (!plan.ok) {
      this.successText.setText('');
      this.costText.setText('');
      this.planDetailText.setColor(DANGER);
      this.planDetailText.setText(plan.text || 'Ese intento no es posible.');

      return;
    }

    this.successText.setText(`Éxito: ${Math.round(plan.chance * 100)}%`);
    this.successText.setColor(this.chanceColor(plan.chance));

    const oro = this.stats ? Number(this.stats.gold) : 0;
    const alcanza = oro >= plan.gold;

    this.costText.setText(`Coste: ${plan.gold} de oro`);
    this.costText.setColor(alcanza ? GOLD : DANGER);

    this.planDetailText.setColor(MUTED);
    this.planDetailText.setText(this.describeFailure(plan));
  }

  // Qué pasa si la tirada sale mal: lo manda el servidor, el cliente solo lo cuenta
  describeFailure(plan) {
    if (plan.chance >= 1) return 'Este tramo no puede fallar.';
    if (plan.failure === 'down') return `Si falla, ${plan.name} baja a +${plan.target - 2}.`;

    return `Si falla, ${plan.name} vuelve a +0.`;
  }

  chanceColor(chance) {
    if (chance >= 0.7) return SUCCESS;
    if (chance >= 0.5) return GOLD;

    return WARNING;
  }

  // Daño o defensa que el ítem hace hoy, ya contada la forja
  describeStats(item) {
    const stats = item.stats || {};

    if (Number(stats.damageMax) > 0) return `Daño ${stats.damageMin}-${stats.damageMax}`;
    if (Number(stats.defense) > 0) return `Defensa ${stats.defense}`;

    return '';
  }

  renderItems() {
    this.itemsLayer.removeAll(true);

    const forjables = this.items.filter((item) => item.equipSlot);

    if (forjables.length === 0) {
      this.itemsLabel.setText('TU EQUIPO');
      this.itemsLayer.add(this.emptyText('No llevas nada que se pueda forjar.', ITEMS_Y));
      return;
    }

    this.itemsLabel.setText(`TU EQUIPO (${forjables.length})`);

    forjables.slice(0, CHIPS_PER_ROW).forEach((item, index) => {
      this.addChip(this.itemsLayer, MARGIN + index * CHIP_PITCH, ITEMS_Y, {
        spriteId: item.spriteId,
        badge: Number(item.enhanceLevel) > 0 ? `+${item.enhanceLevel}` : null,
        selected: item.id === this.selectedItemId,
        onClick: () => this.selectItem(item.id)
      });
    });
  }

  renderGems() {
    this.gemsLayer.removeAll(true);

    const gemas = this.items.filter((item) => item.type === 'Gema');

    // Las gemas del mismo tipo se agrupan: veinte gemas de luz son un chip con un
    // contador, no veinte chips
    const tipos = [];

    gemas.forEach((gema) => {
      const tipo = tipos.find((entry) => entry.name === gema.name);

      if (tipo) {
        tipo.count += 1;
        return;
      }

      tipos.push({ name: gema.name, spriteId: gema.spriteId, count: 1, firstId: gema.id });
    });

    if (tipos.length === 0) {
      this.gemsLabel.setText('GEMAS');
      this.gemsLayer.add(this.emptyText('No tienes gemas.', GEMS_Y));
      return;
    }

    this.gemsLabel.setText(`GEMAS (${gemas.length})`);

    tipos.slice(0, CHIPS_PER_ROW).forEach((tipo, index) => {
      this.addChip(this.gemsLayer, MARGIN + index * CHIP_PITCH, GEMS_Y, {
        spriteId: tipo.spriteId,
        badge: tipo.count > 1 ? `x${tipo.count}` : null,
        selected: tipo.firstId === this.selectedGemId,
        onClick: () => this.selectGem(tipo.firstId)
      });
    });
  }

  emptyText(text, y) {
    return this.scene.add.text(MARGIN + 2, y + CHIP_SIZE / 2, text, {
      fontSize: '11px', fill: MUTED
    }).setOrigin(0, 0.5);
  }

  addChip(layer, x, y, chip) {
    const centerX = x + CHIP_SIZE / 2;
    const centerY = y + CHIP_SIZE / 2;

    const box = this.scene.add.rectangle(centerX, centerY, CHIP_SIZE, CHIP_SIZE, COLOR_SLOT_BG, 1);
    box.setStrokeStyle(chip.selected ? 2 : 1, COLOR_GOLD, chip.selected ? 1 : 0.35);
    box.setInteractive({ useHandCursor: true });
    box.on('pointerover', () => box.setFillStyle(COLOR_SLOT_HOVER));
    box.on('pointerout', () => box.setFillStyle(COLOR_SLOT_BG));
    box.on('pointerdown', chip.onClick);

    layer.add(box);

    if (this.scene.textures.exists(chip.spriteId)) {
      layer.add(this.scene.add.sprite(centerX, centerY, chip.spriteId).setDisplaySize(24, 24));
    }

    if (chip.badge) {
      layer.add(this.scene.add.text(x + CHIP_SIZE - 2, y + CHIP_SIZE - 1, chip.badge, {
        fontSize: '9px', fill: GOLD, fontStyle: 'bold', stroke: '#000000', strokeThickness: 2
      }).setOrigin(1, 1));
    }
  }

  renderButton() {
    const listo = Boolean(this.plan && this.plan.ok) && !this.pending;

    this.buttonBox.setStrokeStyle(2, listo ? COLOR_GOLD : COLOR_GOLD_DIM, 1);
    this.buttonBox.setFillStyle(listo ? COLOR_SLOT_HOVER : COLOR_SLOT_BG, 1);

    if (this.pending) {
      this.buttonText.setText('FORJANDO...');
      this.buttonText.setColor(MUTED);
      return;
    }

    this.buttonText.setText(this.plan && this.plan.ok ? `FORJAR  (+${this.plan.target})` : 'FORJAR');
    this.buttonText.setColor(listo ? GOLD : MUTED);
  }

  hoverButton(over) {
    if (this.pending || !this.plan || !this.plan.ok) return;

    this.buttonBox.setFillStyle(over ? COLOR_GOLD_DIM : COLOR_SLOT_HOVER, 1);
  }

  renderHint() {
    if (this.selectedItemId && this.selectedGemId) {
      this.hintText.setText('Clic en la pieza o en la gema para quitarla del yunque.');
      return;
    }

    this.hintText.setText('Haz clic en una pieza y en una gema para preparar el intento.');
  }

  // --- Avisos -----------------------------------------------------------------

  showNotice(text, color = GREY) {
    this.noticeText.setText(text);
    this.noticeText.setColor(color);

    if (this.noticeTimer) {
      this.noticeTimer.remove();
      this.noticeTimer = null;
    }

    this.noticeTimer = this.scene.time.delayedCall(NOTICE_TTL_MS, () => {
      this.noticeTimer = null;
      this.noticeText.setText('');
    });
  }

  clearNotice() {
    if (this.noticeTimer) {
      this.noticeTimer.remove();
      this.noticeTimer = null;
    }

    this.noticeText.setText('');
  }
}
