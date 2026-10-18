// Nombres legibles de los sufijos del botín (Módulo J).
//
// El servidor guarda las claves crudas en el JSONB de `bonus_attributes`
// (fuerza, daño_critico...). Aquí solo se traducen para el jugador: las reglas
// —cuánto vale cada sufijo, con qué probabilidad sale— viven en el servidor.
export const SUFFIX_LABELS = {
  fuerza: { label: 'Fuerza', percent: false },
  agilidad: { label: 'Agilidad', percent: false },
  inteligencia: { label: 'Inteligencia', percent: false },
  'daño_critico': { label: 'Daño crítico', percent: true },
  robo_vida: { label: 'Robo de vida', percent: true },
  velocidad: { label: 'Velocidad', percent: true }
};

// Texto de un sufijo: 'Fuerza +5', 'Daño crítico +9%'. Un sufijo desconocido se
// muestra tal cual en vez de desaparecer: mejor raro que invisible.
export function describeSuffix(key, value) {
  const entry = SUFFIX_LABELS[key];
  if (!entry) return `${key}: ${value}`;

  return entry.percent ? `${entry.label} +${value}%` : `${entry.label} +${value}`;
}
