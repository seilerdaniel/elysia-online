import Phaser from 'phaser';
import BootScene from './scenes/BootScene';
import GameScene from './scenes/GameScene';

const API_URL = 'http://localhost:5000';
const TOKEN_KEY = 'elysia_token';

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

  // Vuelve al formulario de credenciales
  function showLoginForm() {
    charSelect.classList.add('hidden');
    loginForm.classList.remove('hidden');
    authOverlay.classList.remove('hidden');
  }

  // Pide los personajes del usuario y reabre el overlay de selección
  async function showCharacterSelect(token) {
    const res = await fetch(`${API_URL}/api/characters`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Un token caducado no puede dejar al jugador en una pantalla vacía
    if (!res.ok) {
      showLoginForm();
      return;
    }

    const characters = await res.json();

    charSelectList.innerHTML = '';

    characters.forEach((char) => {
      const div = document.createElement('div');
      div.className = 'char-card';
      div.innerHTML = `<strong>${char.name}</strong> <span>Nivel ${char.level} ${char.character_class}</span>`;
      div.onclick = () => {
        authOverlay.classList.add('hidden');
        // Iniciar el juego pasando el personaje activo y token
        game.scene.start('GameScene', { character: char, token });
      };
      charSelectList.appendChild(div);
    });

    loginForm.classList.add('hidden');
    charSelect.classList.remove('hidden');
    authOverlay.classList.remove('hidden');
  }

  btnLogin.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
      // 1. Iniciar sesión en la API REST
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Error al iniciar sesión');

      localStorage.setItem(TOKEN_KEY, data.token);

      // 2. Mostrar pantalla de selección
      await showCharacterSelect(data.token);

    } catch (err) {
      console.error(err);
      alert('No se pudo conectar con el servidor.');
    }
  });

  // La escena avisa cuando el servidor confirmó el cierre de sesión
  game.events.on('session:returnToAuth', ({ action, token }) => {
    if (action === 'exit') {
      localStorage.removeItem(TOKEN_KEY);
      showLoginForm();
      return;
    }

    // Cambio de personaje: se vuelve a la selección con la misma sesión
    showCharacterSelect(token).catch(() => showLoginForm());
  });
});
