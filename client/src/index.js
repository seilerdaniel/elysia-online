import Phaser from 'phaser';
import BootScene from './scenes/BootScene';
import GameScene from './scenes/GameScene';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game-container',
  pixelArt: true,
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: [BootScene, GameScene]
};

const game = new Phaser.Game(config);

// Manejo del Login y Selección de Personaje
window.addEventListener('DOMContentLoaded', () => {
  const btnLogin = document.getElementById('btn-login');
  const authOverlay = document.getElementById('auth-overlay');
  const loginForm = document.getElementById('login-form');
  const charSelect = document.getElementById('char-select');
  const charSelectList = document.getElementById('char-select-list');

  btnLogin.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
      // 1. Iniciar sesión en la API REST
      const res = await fetch('http://localhost:5000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Error al iniciar sesión');

      localStorage.setItem('elysia_token', data.token);

      // 2. Obtener lista de personajes del usuario
      const charRes = await fetch('http://localhost:5000/api/characters', {
        headers: { 'Authorization': `Bearer ${data.token}` }
      });
      const characters = await charRes.json();

      // 3. Mostrar pantalla de selección
      loginForm.classList.add('hidden');
      charSelect.classList.remove('hidden');
      charSelectList.innerHTML = '';

      characters.forEach(char => {
        const div = document.createElement('div');
        div.className = 'char-card';
        div.innerHTML = `<strong>${char.name}</strong> <span>Nivel ${char.level} ${char.character_class}</span>`;
        div.onclick = () => {
          authOverlay.classList.add('hidden');
          // Iniciar el juego pasando el personaje activo y token
          game.scene.start('GameScene', { character: char, token: data.token });
        };
        charSelectList.appendChild(div);
      });

    } catch (err) {
      console.error(err);
      alert('No se pudo conectar con el servidor.');
    }
  });
});