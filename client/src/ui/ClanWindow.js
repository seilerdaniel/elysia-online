// Ventana de clan (Módulo H). Se abre con la tecla K y enseña la ficha del clan
// con sus miembros, quién está en línea y los botones de aceptar una invitación,
// abandonar el clan o disolverlo.
//
// Las acciones que necesitan un nombre (invitar, expulsar, fundar) se piden por el
// chat, que es donde el juego ya sabe recoger texto: la ventana avisa de los
// comandos disponibles en lugar de inventar un teclado en el lienzo.

// --- Geometría del panel -----------------------------------------------------
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 400;

const MARGIN = 16;
const TITLE_Y = 18;
const INFO_Y = 40;
const HEADER_Y = 62;

const LIST_Y = 78;
const ROW_HEIGHT = 24;
const ROWS_PER_PAGE = 9;

const SEPARATOR_Y = 302;
const HINT_Y = 316;

const BUTTON_Y = 340;
const BUTTON_WIDTH = (PANEL_WIDTH - MARGIN * 3) / 2;
const BUTTON_HEIGHT = 28;
const LEFT_BUTTON_X = MARGIN;
const RIGHT_BUTTON_X = MARGIN * 2 + BUTTON_WIDTH;

const NOTICE_Y = 378;

const ONLINE_DOT_RADIUS = 3;

// --- Paleta ------------------------------------------------------------------
const COLOR_PANEL_BG = 0x0b0c10;
const COLOR_ROW_BG = 0x1f2833;
const COLOR_ROW_HOVER = 0x2c3b4a;
const COLOR_BUTTON = 0x1f2833;
const COLOR_BUTTON_HOVER = 0x2c3b4a;
const COLOR_GOLD = 0xffd700;

const GOLD = '#ffd700';
const GREY = '#cfd8dc';
const WHITE = '#ffffff';
const MUTED = '#78909c';
const ONLINE = '#a5d6a7';
const OFFLINE = '#546e7a';
const LEADER = '#ffd700';
const OFFICER = '#81d4fa';
const SUCCESS = '#a5d6a7';
const WARNING = '#ff8a80';

const NOTICE_TTL_MS = 4000;

export default class ClanWindow {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    this.clan = null;    // ficha del clan, null si no pertenece a ninguno
    this.members = [];
    this.invites = [];   // invitaciones pendientes, de la más nueva a la más vieja

    this.isOpen = false;
    this.page = 0;
    this.noticeTimer = null;

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

    frame.fillStyle(COLOR_PANEL_BG, 0.94);
    frame.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(3, COLOR_GOLD, 1);
    frame.strokeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    frame.lineStyle(1, COLOR_GOLD, 0.35);
    frame.strokeRect(6, 6, PANEL_WIDTH - 12, PANEL_HEIGHT - 12);

    frame.lineStyle(1, COLOR_GOLD, 0.3);
    frame.lineBetween(MARGIN, SEPARATOR_Y, PANEL_WIDTH - MARGIN, SEPARATOR_Y);

    this.container.add(frame);

    const title = this.scene.add.text(MARGIN, TITLE_Y, 'CLAN', {
      fontSize: '13px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    // Nombre y etiqueta del clan, arriba a la derecha
    this.clanLine = this.scene.add.text(PANEL_WIDTH - MARGIN, TITLE_Y, '', {
      fontSize: '12px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    this.infoLine = this.scene.add.text(MARGIN, INFO_Y, '', {
      fontSize: '11px', fill: GREY
    }).setOrigin(0, 0.5);

    // Cabecera de la tabla de miembros
    this.memberHeader = this.scene.add.text(MARGIN + 4, HEADER_Y, 'MIEMBRO', {
      fontSize: '10px', fill: MUTED, fontStyle: 'bold'
    }).setOrigin(0, 0.5);

    this.rankHeader = this.scene.add.text(PANEL_WIDTH - MARGIN, HEADER_Y, 'RANGO', {
      fontSize: '10px', fill: MUTED, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    // Paginación de la lista: un clan puede pasar de la pantalla
    this.pageText = this.scene.add.text(PANEL_WIDTH - MARGIN, HEADER_Y + 16, '', {
      fontSize: '10px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(1, 0.5);

    this.prev = this.buildArrow(MARGIN + 4, HEADER_Y + 16, '◀', () => this.changePage(-1));
    this.next = this.buildArrow(MARGIN + 22, HEADER_Y + 16, '▶', () => this.changePage(1));

    // Las filas se reconstruyen enteras en cada refresco
    this.rows = this.scene.add.container(0, 0);

    this.hintText = this.scene.add.text(MARGIN, HINT_Y, '', {
      fontSize: '10px', fill: MUTED
    }).setOrigin(0, 0.5);

    this.noticeText = this.scene.add.text(PANEL_WIDTH / 2, NOTICE_Y, '', {
      fontSize: '11px',
      fill: GREY,
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: PANEL_WIDTH - MARGIN * 2 }
    }).setOrigin(0.5);

    this.container.add([
      title,
      this.clanLine,
      this.infoLine,
      this.memberHeader,
      this.rankHeader,
      this.pageText,
      this.prev,
      this.next,
      this.rows,
      this.hintText,
      this.noticeText
    ]);

    // Izquierda: aceptar la invitación pendiente o abandonar el clan.
    // Derecha: disolver, solo para el líder.
    this.leftButton = this.buildButton(LEFT_BUTTON_X, () => this.handleLeftAction());
    this.rightButton = this.buildButton(RIGHT_BUTTON_X, () => this.socket.emit('dissolveClan'));
  }

  buildArrow(x, y, glyph, onClick) {
    const arrow = this.scene.add.text(x, y, glyph, {
      fontSize: '10px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    arrow.on('pointerover', () => arrow.setColor(WHITE));
    arrow.on('pointerout', () => arrow.setColor(GOLD));
    arrow.on('pointerdown', onClick);

    return arrow;
  }

  buildButton(x, onClick) {
    const centerX = x + BUTTON_WIDTH / 2;

    const rect = this.scene.add.rectangle(
      centerX,
      BUTTON_Y,
      BUTTON_WIDTH,
      BUTTON_HEIGHT,
      COLOR_BUTTON,
      1
    ).setStrokeStyle(1, COLOR_GOLD, 0.6);

    const label = this.scene.add.text(centerX, BUTTON_Y, '', {
      fontSize: '11px', fill: GOLD, fontStyle: 'bold'
    }).setOrigin(0.5);

    const zone = this.scene.add.zone(centerX, BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT)
      .setOrigin(0.5);

    zone.on('pointerover', () => rect.setFillStyle(COLOR_BUTTON_HOVER));
    zone.on('pointerout', () => rect.setFillStyle(COLOR_BUTTON));
    zone.on('pointerdown', onClick);

    this.container.add([rect, label, zone]);

    return { rect, label, zone, onClick };
  }

  // --- API pública ------------------------------------------------------------

  toggle() {
    this.isOpen = !this.isOpen;
    this.container.setVisible(this.isOpen);

    if (this.isOpen) {
      // La ficha se pide al abrir: puede haber cambiado desde la última vez
      this.socket.emit('requestClan');
      this.render();
    } else {
      this.clearNotice();
    }

    return this.isOpen;
  }

  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.setVisible(false);
    this.clearNotice();
  }

  // Ficha del clan tal y como la manda el servidor
  setClanState(state) {
    this.clan = (state && state.clan) || null;
    this.members = (state && state.members) || [];

    // Al entrar en un clan las invitaciones dejan de tener sentido
    if (this.clan) this.invites = [];

    if (this.isOpen) this.render();
  }

  addInvite(invite) {
    if (!invite || !invite.clanId) return;

    // Una invitación por clan: la nueva sustituye a la anterior
    this.invites = this.invites.filter((pending) => pending.clanId !== invite.clanId);
    this.invites.unshift(invite);

    this.showNotice(`Te invitan al clan ${invite.clanName}.`, GOLD);

    if (this.isOpen) this.render();
  }

  // --- Render -----------------------------------------------------------------

  render() {
    this.renderHeader();
    this.renderMembers();
    this.renderButtons();
  }

  renderHeader() {
    if (!this.clan) {
      this.clanLine.setText('Sin clan');
      this.infoLine.setText(this.invites.length > 0
        ? `Invitación pendiente: ${this.invites[0].clanName}`
        : 'No perteneces a ningún clan.');

      this.hintText.setText('Fundar: /crearclan <nombre> (nivel 20 y 10.000 de oro)');
      return;
    }

    const total = this.members.length;

    this.clanLine.setText(`${this.clan.name} <${this.clan.tag}>`);
    this.infoLine.setText(
      `Nivel ${this.clan.level} · ${total} ${total === 1 ? 'miembro' : 'miembros'} · ` +
      `Tu rango: ${this.clan.rank}`
    );

    this.hintText.setText('Invitar: /invitar <nombre> · Expulsar: /expulsar <nombre>');
  }

  renderMembers() {
    this.rows.removeAll(true);

    if (!this.clan) {
      this.memberHeader.setVisible(false);
      this.rankHeader.setVisible(false);
      this.pageText.setVisible(false);
      this.prev.setVisible(false);
      this.next.setVisible(false);

      const empty = this.scene.add.text(MARGIN + 4, LIST_Y + 14, 'Sin miembros que mostrar.', {
        fontSize: '11px', fill: MUTED
      }).setOrigin(0, 0.5);

      this.rows.add(empty);
      return;
    }

    this.memberHeader.setVisible(true);
    this.rankHeader.setVisible(true);

    const pages = Math.max(1, Math.ceil(this.members.length / ROWS_PER_PAGE));
    if (this.page > pages - 1) this.page = pages - 1;

    const hasPages = pages > 1;
    this.pageText.setVisible(hasPages);
    this.pageText.setText(hasPages ? `${this.page + 1}/${pages}` : '');
    this.prev.setVisible(hasPages);
    this.next.setVisible(hasPages);

    const start = this.page * ROWS_PER_PAGE;
    const visible = this.members.slice(start, start + ROWS_PER_PAGE);

    visible.forEach((member, index) => {
      this.buildMemberRow(LIST_Y + index * ROW_HEIGHT, member);
    });
  }

  buildMemberRow(y, member) {
    const centerY = y + ROW_HEIGHT / 2 - 1;
    const isSelf = this.scene.player && this.scene.player.playerName === member.name;

    const background = this.scene.add.rectangle(
      PANEL_WIDTH / 2,
      centerY,
      PANEL_WIDTH - MARGIN * 2,
      ROW_HEIGHT - 2,
      COLOR_ROW_BG,
      1
    );

    // Punto verde si está dentro, apagado si no
    const dot = this.scene.add.circle(
      MARGIN + 12,
      centerY,
      ONLINE_DOT_RADIUS,
      member.online ? 0xa5d6a7 : 0x546e7a,
      1
    );

    const name = this.scene.add.text(
      MARGIN + 24,
      centerY,
      `${member.name}${isSelf ? ' (tú)' : ''} [Niv.${member.level}]`,
      { fontSize: '11px', fill: member.online ? GREY : MUTED }
    ).setOrigin(0, 0.5);

    const rank = this.scene.add.text(
      PANEL_WIDTH - MARGIN,
      centerY,
      member.rank,
      { fontSize: '11px', fill: this.rankColor(member.rank), fontStyle: 'bold' }
    ).setOrigin(1, 0.5);

    this.rows.add([background, dot, name, rank]);
  }

  rankColor(rank) {
    if (rank === 'Líder') return LEADER;
    if (rank === 'Oficial') return OFFICER;

    return GREY;
  }

  renderButtons() {
    if (!this.clan) {
      const invite = this.invites[0] || null;

      this.setButton(
        this.leftButton,
        invite ? `ACEPTAR ${invite.clanName.toUpperCase()}` : '',
        Boolean(invite)
      );

      this.setButton(this.rightButton, '', false);
      return;
    }

    // El líder no puede marcharse: su botón es disolver
    const isLeader = this.clan.rank === 'Líder';

    this.setButton(this.leftButton, isLeader ? '' : 'ABANDONAR CLAN', !isLeader);
    this.setButton(this.rightButton, 'DISOLVER CLAN', isLeader);
  }

  setButton(button, text, visible) {
    button.rect.setVisible(visible);
    button.label.setVisible(visible);

    if (visible) {
      button.label.setText(text);
      button.zone.setInteractive({ useHandCursor: true });
    } else {
      button.zone.disableInteractive();
    }
  }

  changePage(delta) {
    const pages = Math.max(1, Math.ceil(this.members.length / ROWS_PER_PAGE));
    if (pages <= 1) return;

    this.page = (this.page + delta + pages) % pages;
    this.renderMembers();
  }

  handleLeftAction() {
    if (this.clan) {
      this.socket.emit('leaveClan');
      return;
    }

    const invite = this.invites[0];
    if (invite) this.socket.emit('acceptClanInvite', { clanId: invite.clanId });
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

  clearNotice() {
    if (this.noticeTimer) {
      this.noticeTimer.remove();
      this.noticeTimer = null;
    }

    this.noticeText.setText('');
  }
}
