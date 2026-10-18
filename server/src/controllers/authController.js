const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Registro de Usuario
exports.register = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  try {
    // Verificar si el usuario o email ya existe
    const existingUser = await db.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'El nombre de usuario o email ya está en uso' });
    }

    // Encriptar contraseña
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Insertar nuevo usuario
    const newUser = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, is_vip, coins_premium, created_at',
      [username, email, passwordHash]
    );

    const user = newUser.rows[0];

    // Generar JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      token,
      user
    });
  } catch (error) {
    console.error('Error en Registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Inicio de Sesión (Login)
exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  try {
    const userResult = await db.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = userResult.rows[0];

    // Verificar contraseña
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Generar JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    delete user.password_hash; // No enviar la contraseña encriptada

    res.json({
      message: 'Inicio de sesión exitoso',
      token,
      user
    });
  } catch (error) {
    console.error('Error en Login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
