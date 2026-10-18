import {
  KEYBIND_ACTIONS,
  RESERVED_KEYS,
  actionLabel,
  findActionByKey,
  formatKeyLabel
} from '../config/keybinds';

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 372;

const TITLE_Y = 20;
const CONTROLS_LABEL_Y = 46;

const ROW_START_Y = 70;
const ROW_STEP = 30;
const ROW_LABEL_X = 22;

const KEY_BOX_WIDTH = 130;
const KEY_BOX_HEIGHT = 22;
const KEY_BOX_RIGHT = PANEL_WIDTH - ROW_LABEL_X;

const SEPARATOR_Y = 282;
const SESSION_LABEL_Y = 299;

const BUTTON_Y = 322;
const BUTTON_WIDTH = 192;
const BUTTON_HEIGHT = 30;
const BUTTON_LEFT_X = ROW_LABEL_X;
const BUTTON_RIGHT_X = PANEL_WIDTH - ROW_LABEL_X - BUTTON_WIDTH;

const NOTICE_Y = 353;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_SLOT_BG = 0x1f2833;
const COLOR_CAPTURE = 0x7a5c00;
const COLOR_GOLD = 0xffd700;
const COLOR_SELECT = 0x2e6f6b;
const COLOR_EXIT = 0x8e2d2d;
const GOLD = '#ffd700';
const WHITE = '#ffffff';
const GREY = '#cfd8dc';
const WARNING = '#ff8a80';
const SUCCESS = '#a5d6a7';
const CANCELLED = '#ffb74d';

const NOTICE_TTL_MS = 3500;

export default class SettingsWindow {
  constructor(scene, socket, { keybinds, onKeybindChange }) {
    this.scene = scene;
    this.socket = socket;
    this.onKeybindChange = onKeybindChange || (() => {});

    this.keybinds = { ...keybinds };
    this.isOpen = false;

    this.capturingAction = null;  // acción a la espera de una tecla nueva
    this.logoutRequested = false; // el servidor ya recibió la petición de cierre
    this.noticeTimer = null;
    this.countdownTimer = null;
    this.countdownBlink = null;

    this.rows = {};

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

    // Separador entre la configuración de controles y la de sesión
    frame.lineStyle(1, COLOR_GOLD, 0.3);
    frame.lineBetween(ROW_LABEL_X, SEPARATOR_Y, PANEL_WIDTH - ROW_LABEL_X, SEPARATOR_Y);

    this.container.add(frame);

    const title = this.scene.add.text(PANEL_WIDTH / 2, TITLE_Y, 'OPCIONES', {
      fontSize: '14px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0.5);

    const controlsLabel = this.scene.add.text(ROW_LABEL_X, CONTROLS_LABEL_Y, 'CONTROLES', {
      fontSize: '10px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    const sessionLabel = this.scene.add.text(ROW_LABEL_X, SESSION_LABEL_Y, 'SESIÓN', {
      fontSize: '10px', fill: GREY, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.noticeText = this.scene.add.text(PANEL_WIDTH / 2, NOTICE_Y, '', {
      fontSize: '10px',
      fill: GREY,
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: PANEL_WIDTH - ROW_LABEL_X * 2 }
    }).setOrigin(0.5);

    this.container.add([title, controlsLabel, sessionLabel, this.noticeText]);

    this.buildControlRows();
    this.buildSessionButtons();
  }

  buildControlRows() {
    KEYBIND_ACTIONS.forEach((action, index) => {
      const y = ROW_START_Y + index * ROW_STEP;

      const label = this.scene.add.text(ROW_LABEL_X + 4, y, action.label, {
        fontSize: '11px', fill: GREY
      }).setOrigin(0, 0.5);

      const box = this.scene.add.graphics();

      const text = this.scene.add.text(KEY_BOX_RIGHT - KEY_BOX_WIDTH / 2, y, '', {
        fontSize: '11px', fill: GOLD, fontStyle: 'bold'
      }).setOrigin(0.5);

      // Toda la fila es clicable: es más fácil acertar que a la cajita sola
      const zone = this.scene.add.zone(
        (ROW_LABEL_X + KEY_BOX_RIGHT) / 2,
        y,
        KEY_BOX_RIGHT - ROW_LABEL_X,
        ROW_STEP - 4
      ).setOrigin(0.5).setInteractive({ useHandCursor: true });

      zone.on('pointerover', () => label.setColor(WHITE));
      zone.on('pointerout', () => label.setColor(GREY));
      zone.on('pointerdown', () => this.beginKeyCapture(action.id));

      this.rows[action.id] = { y, label, box, text };
      this.container.add([label, box, text, zone]);
    });

    this.refreshControlRows();
  }

  buildSessionButtons() {
    this.buildButton(BUTTON_LEFT_X, 'Seleccionar personaje', 'select_character', COLOR_SELECT);
    this.buildButton(BUTTON_RIGHT_X, 'Cerrar sesión', 'exit', COLOR_EXIT);
  }

  buildButton(x, label, action, color) {
    const top = BUTTON_Y - BUTTON_HEIGHT / 2;

    const background = this.scene.add.graphics();
    background.fillStyle(color, 1);
    background.fillRect(x, top, BUTTON_WIDTH, BUTTON_HEIGHT);
    background.lineStyle(1, COLOR_GOLD, 0.7);
    background.strokeRect(x, top, BUTTON_WIDTH, BUTTON_HEIGHT);

    const text = this.scene.add.text(x + BUTTON_WIDTH / 2, BUTTON_Y, label, {
      fontSize: '12px', fill: WHITE, fontStyle: 'bold'
    }).setOrigin(0.5);

    const zone = this.scene.add.zone(x + BUTTON_WIDTH / 2, BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    zone.on('pointerover', () => text.setColor(GOLD));
    zone.on('pointerout', () => text.setColor(WHITE));
    zone.on('pointerdown', () => this.requestLogout(action));

    this.container.add([background, text, zone]);
  }

  // --- API pública ------------------------------------------------------------

  setKeybinds(keybinds) {
    this.keybinds = { ...keybinds };
    this.refreshControlRows();
  }

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    // Cerrar el panel descarta una reasignación a medias
    if (!this.isOpen) this.cancelKeyCapture();

    return this.isOpen;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
    this.cancelKeyCapture();
  }

  get isCapturingKey() {
    return this.capturingAction !== null;
  }

  get isLogoutPending() {
    return this.logoutRequested;
  }

  // --- Reasignación de controles ----------------------------------------------

  beginKeyCapture(actionId) {
    this.capturingAction = actionId;
    this.refreshControlRows();
    this.showNotice(`Pulsa la nueva tecla para "${actionLabel(actionId)}" (Esc cancela).`, GOLD);
  }

  // Recibe el código ya normalizado por la escena. Devuelve true cuando la
  // pulsación se consumió reasignando un control.
  captureKey(code) {
    if (!this.capturingAction) return false;

    const actionId = this.capturingAction;

    if (code === 'Escape') {
      this.cancelKeyCapture();
      return true;
    }

    const error = this.validateKey(code, actionId);
    if (error) {
      // Se sigue en modo captura: el jugador puede probar con otra tecla
      this.showNotice(error, WARNING);
      return true;
    }

    this.keybinds[actionId] = code;
    this.capturingAction = null;
    this.refreshControlRows();
    this.showNotice(`"${actionLabel(actionId)}" ahora usa ${formatKeyLabel(code)}.`, SUCCESS);

    this.onKeybindChange(this.keybinds);

    return true;
  }

  cancelKeyCapture() {
    if (!this.capturingAction) return false;

    this.capturingAction = null;
    this.refreshControlRows();

    if (this.isOpen) this.showNotice('Reasignación cancelada.', CANCELLED);

    return true;
  }

  // Mensaje de error, o null si la tecla se puede asignar a esa acción
  validateKey(code, actionId) {
    if (!code) return 'Esa tecla no se puede usar.';

    // Si Esc dejara de estar reservada, el menú se volvería inalcanzable
    if (RESERVED_KEYS[code]) return `Esa tecla está reservada para ${RESERVED_KEYS[code]}.`;

    const taken = findActionByKey(this.keybinds, code);
    if (taken && taken !== actionId) {
      return `Esa tecla ya está asignada a "${actionLabel(taken)}".`;
    }

    return null;
  }

  refreshControlRows() {
    KEYBIND_ACTIONS.forEach((action) => {
      const row = this.rows[action.id];
      const capturing = this.capturingAction === action.id;

      row.text.setText(capturing ? 'Pulsa una tecla…' : formatKeyLabel(this.keybinds[action.id]));
      row.text.setColor(capturing ? WHITE : GOLD);

      const left = KEY_BOX_RIGHT - KEY_BOX_WIDTH;
      const top = row.y - KEY_BOX_HEIGHT / 2;

      row.box.clear();
      row.box.fillStyle(capturing ? COLOR_CAPTURE : COLOR_SLOT_BG, 1);
      row.box.fillRect(left, top, KEY_BOX_WIDTH, KEY_BOX_HEIGHT);
      row.box.lineStyle(capturing ? 2 : 1, COLOR_GOLD, capturing ? 1 : 0.5);
      row.box.strokeRect(left, top, KEY_BOX_WIDTH, KEY_BOX_HEIGHT);
    });
  }

  // --- Cierre de sesión -------------------------------------------------------

  requestLogout(action) {
    // Evita encadenar peticiones mientras el servidor decide qué hacer
    if (this.logoutRequested) return;

    this.logoutRequested = true;
    this.showNotice('Guardando partida…', GREY);

    this.socket.emit('requestLogout', { action });
  }

  // El servidor no deja salir en combate: aviso flotante con la cuenta regresiva
  showLogoutCountdown(seconds) {
    this.hideLogoutCountdown();

    let remaining = seconds;

    const render = () => {
      this.noticeText.setText(`⚠ En combate: cerrando sesión en ${remaining} s (muévete para cancelar)`);
      this.noticeText.setColor(WARNING);
    };

    render();

    // El parpadeo convierte el aviso en algo imposible de ignorar
    this.countdownBlink = this.scene.tweens.add({
      targets: this.noticeText,
      alpha: 0.3,
      duration: 400,
      yoyo: true,
      repeat: -1
    });

    this.countdownTimer = this.scene.time.addEvent({
      delay: 1000,
      repeat: seconds - 1,
      callback: () => {
        remaining -= 1;
        if (remaining > 0) render();
      }
    });
  }

  // Moverse o atacar cancela el cierre: el servidor hace lo mismo por su lado
  clearLogoutRequest() {
    if (!this.logoutRequested) return;

    this.logoutRequested = false;
    this.hideLogoutCountdown();
    this.showNotice('Cierre de sesión cancelado.', CANCELLED);
  }

  hideLogoutCountdown() {
    if (this.countdownTimer) {
      this.countdownTimer.remove();
      this.countdownTimer = null;
    }

    if (this.countdownBlink) {
      this.countdownBlink.stop();
      this.countdownBlink = null;
      this.noticeText.setAlpha(1);
    }
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

        // Una cuenta regresiva en curso no debe borrarse sola
        if (!this.countdownTimer) this.noticeText.setText('');
      });
    }
  }
}
