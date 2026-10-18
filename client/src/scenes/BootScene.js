import Phaser from 'phaser';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    // Generar texturas de Pixel Art en memoria (32x32 tiles)
    this.createPixelTextures();
    // Generar texturas de los ítems que caen al suelo (16x16)
    this.createItemTextures();
  }

  create() {
    this.scene.start('GameScene');
  }

  createPixelTextures() {
    // 1. Baldosa de Pasto (Grass Tile)
    const grassCanvas = this.textures.createCanvas('grass', 32, 32);
    const ctx = grassCanvas.getContext();
    ctx.fillStyle = '#2e7d32';
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = '#388e3c';
    ctx.fillRect(4, 4, 8, 8);
    ctx.fillRect(18, 20, 6, 6);
    grassCanvas.refresh();

    // 2. Baldosa de Camino de Piedra (Cobblestone Tile)
    const stoneCanvas = this.textures.createCanvas('stone', 32, 32);
    const ctxStone = stoneCanvas.getContext();
    ctxStone.fillStyle = '#424242';
    ctxStone.fillRect(0, 0, 32, 32);
    ctxStone.fillStyle = '#616161';
    ctxStone.fillRect(2, 2, 12, 12);
    ctxStone.fillRect(16, 16, 14, 14);
    stoneCanvas.refresh();

    // 3. Personaje - Guerrero (Player Sprite 32x32 Pixel Art)
    const playerCanvas = this.textures.createCanvas('player', 32, 32);
    const ctxP = playerCanvas.getContext();
    // Cuerpo / Armadura
    ctxP.fillStyle = '#1565c0'; // Azul Caballero
    ctxP.fillRect(8, 10, 16, 16);
    // Cabeza / Casco
    ctxP.fillStyle = '#9e9e9e'; // Metal
    ctxP.fillRect(10, 2, 12, 10);
    // Visor
    ctxP.fillStyle = '#000000';
    ctxP.fillRect(12, 6, 8, 2);
    // Espada
    ctxP.fillStyle = '#e0e0e0';
    ctxP.fillRect(24, 6, 4, 16);
    playerCanvas.refresh();

    // 4. Monstruo / Demonio de prueba
    const monsterCanvas = this.textures.createCanvas('monster', 32, 32);
    const ctxM = monsterCanvas.getContext();
    ctxM.fillStyle = '#c62828'; // Rojo carmesí
    ctxM.fillRect(8, 8, 16, 16);
    ctxM.fillStyle = '#ffeb3b'; // Ojos amarillos
    ctxM.fillRect(10, 12, 4, 4);
    ctxM.fillRect(18, 12, 4, 4);
    monsterCanvas.refresh();

    // 13. Comerciante (NPC de la tienda): túnica marrón con ribete dorado
    const merchantCanvas = this.textures.createCanvas('merchant', 32, 32);
    const ctxMer = merchantCanvas.getContext();
    // Túnica
    ctxMer.fillStyle = '#6d4c41';
    ctxMer.fillRect(7, 13, 18, 17);
    // Capa sobre los hombros
    ctxMer.fillStyle = '#4e342e';
    ctxMer.fillRect(5, 12, 22, 4);
    // Ribete dorado
    ctxMer.fillStyle = '#ffd700';
    ctxMer.fillRect(7, 15, 18, 2);
    ctxMer.fillRect(15, 17, 2, 13);
    // Cabeza y barba blanca
    ctxMer.fillStyle = '#ffcc80';
    ctxMer.fillRect(11, 3, 10, 10);
    ctxMer.fillStyle = '#eceff1';
    ctxMer.fillRect(11, 10, 10, 3);
    // Ojos
    ctxMer.fillStyle = '#000000';
    ctxMer.fillRect(13, 6, 2, 2);
    ctxMer.fillRect(17, 6, 2, 2);
    // Bolsa de oro
    ctxMer.fillStyle = '#ffd700';
    ctxMer.fillRect(25, 16, 5, 5);
    merchantCanvas.refresh();
  }

  createItemTextures() {
    // 5. Poción de Vida (Rojo)
    const redCanvas = this.textures.createCanvas('potion_red', 16, 16);
    const ctxRed = redCanvas.getContext();
    ctxRed.fillStyle = '#8d6e63'; // Corcho
    ctxRed.fillRect(6, 1, 4, 2);
    ctxRed.fillStyle = '#e53935'; // Líquido
    ctxRed.fillRect(7, 3, 2, 2);
    ctxRed.fillRect(4, 5, 8, 9);
    ctxRed.fillStyle = '#ff8a80'; // Brillo
    ctxRed.fillRect(5, 6, 2, 3);
    redCanvas.refresh();

    // 6. Poción de Maná (Azul)
    const blueCanvas = this.textures.createCanvas('potion_blue', 16, 16);
    const ctxBlue = blueCanvas.getContext();
    ctxBlue.fillStyle = '#8d6e63';
    ctxBlue.fillRect(6, 1, 4, 2);
    ctxBlue.fillStyle = '#1e88e5';
    ctxBlue.fillRect(7, 3, 2, 2);
    ctxBlue.fillRect(4, 5, 8, 9);
    ctxBlue.fillStyle = '#90caf9';
    ctxBlue.fillRect(5, 6, 2, 3);
    blueCanvas.refresh();

    // 7. Espada de Hierro
    const swordCanvas = this.textures.createCanvas('sword', 16, 16);
    const ctxSword = swordCanvas.getContext();
    ctxSword.fillStyle = '#e0e0e0'; // Hoja
    ctxSword.fillRect(7, 1, 2, 10);
    ctxSword.fillStyle = '#9e9e9e'; // Filo
    ctxSword.fillRect(9, 1, 1, 10);
    ctxSword.fillStyle = '#8d6e63'; // Guarda
    ctxSword.fillRect(4, 11, 8, 2);
    ctxSword.fillStyle = '#5d4037'; // Mango
    ctxSword.fillRect(7, 13, 2, 3);
    swordCanvas.refresh();

    // 8. Escudo de Roble
    const shieldCanvas = this.textures.createCanvas('shield', 16, 16);
    const ctxShield = shieldCanvas.getContext();
    ctxShield.fillStyle = '#795548'; // Madera
    ctxShield.fillRect(3, 2, 10, 10);
    ctxShield.fillStyle = '#bcaaa4'; // Refuerzo superior
    ctxShield.fillRect(3, 2, 10, 1);
    ctxShield.fillStyle = '#ffd700'; // Umbo dorado
    ctxShield.fillRect(7, 5, 2, 4);
    shieldCanvas.refresh();

    // 9. Coraza de Placas
    const armorCanvas = this.textures.createCanvas('armor', 16, 16);
    const ctxArmor = armorCanvas.getContext();
    ctxArmor.fillStyle = '#9e9e9e'; // Placas
    ctxArmor.fillRect(3, 3, 10, 10);
    ctxArmor.fillStyle = '#616161'; // Hombreras
    ctxArmor.fillRect(2, 3, 12, 2);
    ctxArmor.fillStyle = '#ffd700'; // Ribete dorado
    ctxArmor.fillRect(6, 3, 4, 1);
    ctxArmor.fillStyle = '#424242'; // Unión central
    ctxArmor.fillRect(7, 6, 2, 6);
    armorCanvas.refresh();

    // 10. Gema de Luz (Rombo dorado)
    const gemCanvas = this.textures.createCanvas('gem', 16, 16);
    const ctxGem = gemCanvas.getContext();
    ctxGem.fillStyle = '#ffd700';
    ctxGem.fillRect(7, 1, 2, 1);
    ctxGem.fillRect(5, 2, 6, 2);
    ctxGem.fillRect(3, 4, 10, 4);
    ctxGem.fillRect(5, 8, 6, 2);
    ctxGem.fillRect(7, 10, 2, 1);
    ctxGem.fillStyle = '#fff59d'; // Faceta iluminada
    ctxGem.fillRect(5, 4, 2, 2);
    gemCanvas.refresh();

    // 11. Esfera de Alma (Orbe dorado)
    const sphereCanvas = this.textures.createCanvas('sphere', 16, 16);
    const ctxSphere = sphereCanvas.getContext();
    ctxSphere.fillStyle = '#ffd700';
    ctxSphere.fillRect(6, 2, 4, 2);
    ctxSphere.fillRect(4, 4, 8, 8);
    ctxSphere.fillRect(6, 12, 4, 2);
    ctxSphere.fillStyle = '#ff8f00'; // Núcleo
    ctxSphere.fillRect(6, 9, 4, 2);
    ctxSphere.fillStyle = '#fff59d'; // Brillo
    ctxSphere.fillRect(5, 5, 3, 3);
    sphereCanvas.refresh();

    // 12. Piedra del Caos (Roca oscura con núcleo rojo)
    const chaosCanvas = this.textures.createCanvas('chaos_stone', 16, 16);
    const ctxChaos = chaosCanvas.getContext();
    ctxChaos.fillStyle = '#6a1b9a';
    ctxChaos.fillRect(5, 3, 6, 1);
    ctxChaos.fillRect(4, 4, 8, 8);
    ctxChaos.fillRect(5, 12, 6, 1);
    ctxChaos.fillStyle = '#ce93d8'; // Brillo
    ctxChaos.fillRect(5, 5, 2, 2);
    ctxChaos.fillStyle = '#ff1744'; // Núcleo
    ctxChaos.fillRect(7, 7, 2, 2);
    chaosCanvas.refresh();
  }
}
