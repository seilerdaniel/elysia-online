// Reasignación de controles (Módulo F).
//
// La tecla se identifica por `event.code`, la posición FÍSICA en el teclado, y no
// por `event.key`: así el atajo no se rompe si el jugador mantiene Shift pulsado
// o usa un layout distinto al del autor del juego.

export const KEYBIND_STORAGE_KEY = 'elysia_keybinds';

// Teclas que la interfaz reserva para sí misma: nunca pueden asignarse a una acción
export const RESERVED_KEYS = {
  Escape: 'abrir y cerrar este menú'
};

// Acciones reasignables, en el orden en que se muestran en el menú
//
// La habilidad de clase va en 3 y no en 1/2 porque las pociones ya viven ahí
// desde el Módulo E: moverlas habría roto los atajos que los jugadores tengan
// guardados. El clic derecho sobre el mapa lanza la habilidad igual, apuntando.
export const KEYBIND_ACTIONS = [
  { id: 'attack', label: 'Atacar', defaultKey: 'Space' },
  { id: 'skill', label: 'Habilidad', defaultKey: 'Digit3' },
  { id: 'inventory', label: 'Inventario', defaultKey: 'KeyI' },
  { id: 'character', label: 'Personaje', defaultKey: 'KeyC' },
  { id: 'pickup', label: 'Recoger', defaultKey: 'KeyG' },
  { id: 'shop', label: 'Tienda', defaultKey: 'KeyE' },
  { id: 'clan', label: 'Clan', defaultKey: 'KeyK' },
  { id: 'forge', label: 'Forja', defaultKey: 'KeyF' },
  { id: 'potionHp', label: 'Poción HP', defaultKey: 'Digit1' },
  { id: 'potionMp', label: 'Poción MP', defaultKey: 'Digit2' },
  { id: 'chat', label: 'Chat', defaultKey: 'Enter' }
];

const ACTION_IDS = KEYBIND_ACTIONS.map((action) => action.id);

// Nombres legibles de las teclas que no se deducen del código
const KEY_LABELS = {
  Space: 'Espacio',
  Enter: 'Enter',
  NumpadEnter: 'Enter (Num)',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Retroceso',
  Delete: 'Supr',
  Insert: 'Insert',
  Home: 'Inicio',
  End: 'Fin',
  PageUp: 'Av Pág',
  PageDown: 'Re Pág',
  CapsLock: 'Bloq Mayús',
  ShiftLeft: 'Shift Izq.',
  ShiftRight: 'Shift Der.',
  ControlLeft: 'Ctrl Izq.',
  ControlRight: 'Ctrl Der.',
  AltLeft: 'Alt Izq.',
  AltRight: 'Alt Der.',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
};

// Mapa por defecto { accion: tecla }
export function defaultKeybinds() {
  return Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action.id, action.defaultKey]));
}

// Código de tecla de una pulsación. `event.code` es la fuente correcta y la única
// que da igual el layout. Algunos entornos (navegadores embebidos, escritorio
// remoto, eventos inyectados) lo entregan vacío: ahí se deduce de `event.key`
// para que los atajos no queden muertos.
export function resolveKeyCode(event) {
  if (event.code) return event.code;

  const key = event.key;
  if (!key) return null;

  if (key === ' ') return 'Space';
  if (key.length === 1) {
    if (key >= 'a' && key <= 'z') return `Key${key.toUpperCase()}`;
    if (key >= 'A' && key <= 'Z') return `Key${key}`;
    if (key >= '0' && key <= '9') return `Digit${key}`;
    return null;
  }

  // 'Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp'... coinciden con el nombre del code
  return key;
}

// Texto legible de una tecla: 'KeyI' -> 'I', 'Digit1' -> '1', 'Space' -> 'Espacio'
export function formatKeyLabel(code) {
  if (!code) return '—';
  if (KEY_LABELS[code]) return KEY_LABELS[code];

  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;

  return code;
}

// Etiqueta legible de una acción
export function actionLabel(actionId) {
  const action = KEYBIND_ACTIONS.find((entry) => entry.id === actionId);

  return action ? action.label : actionId;
}

// Acción que tiene asignada una tecla, o null si la tecla está libre
export function findActionByKey(keybinds, code) {
  const entry = Object.entries(keybinds).find(([, key]) => key === code);

  return entry ? entry[0] : null;
}

// Carga los atajos guardados, ignorando entradas corruptas, de acciones que ya
// no existen o de teclas reservadas. Lo que falte cae al valor por defecto.
export function loadKeybinds() {
  const keybinds = defaultKeybinds();

  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEYBIND_STORAGE_KEY) || 'null');
  } catch (error) {
    // Un JSON corrupto no debe impedir jugar: se ignoran las preferencias
    stored = null;
  }

  if (!stored || typeof stored !== 'object') return keybinds;

  ACTION_IDS.forEach((actionId) => {
    const key = stored[actionId];

    // Esc se guarda con el resto del mapa, pero pertenece al menú
    if (typeof key !== 'string' || RESERVED_KEYS[key]) return;

    keybinds[actionId] = key;
  });

  return keybinds;
}

export function saveKeybinds(keybinds) {
  try {
    localStorage.setItem(KEYBIND_STORAGE_KEY, JSON.stringify(keybinds));
  } catch (error) {
    console.error('No se pudieron guardar los atajos:', error);
  }
}
