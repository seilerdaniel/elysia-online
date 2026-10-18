import Phaser from 'phaser';

// Aura de un objeto: un par de copias del propio sprite, más grandes, con mezcla
// aditiva y sin animación. postFX.addGlow daría lo mismo pero solo existe en
// WebGL; esto se ve igual en Canvas y, sobre todo, se puede meter dentro de un
// contenedor del HUD sin pelearse con la cámara.
//
// Quien llama decide qué hacer con las copias: el inventario las añade a su capa
// de ítems y el suelo las mete en el mismo movimiento que el drop.
export function createGlowSprites(scene, x, y, spriteId, style, size) {
  if (!style || !spriteId || !scene.textures.exists(spriteId)) return [];

  const capas = [
    { color: style.outer, escala: style.scale, alpha: style.alpha },
    { color: style.inner, escala: style.scale * 0.8, alpha: style.alpha * 0.85 }
  ];

  return capas.map((capa) => scene.add.sprite(x, y, spriteId)
    .setDisplaySize(size * capa.escala, size * capa.escala)
    .setTint(capa.color)
    .setAlpha(capa.alpha)
    .setBlendMode(Phaser.BlendModes.ADD));
}
