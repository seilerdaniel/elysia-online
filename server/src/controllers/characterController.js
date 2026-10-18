const db = require('../config/db');

// Obtener los personajes de la cuenta del usuario
exports.getCharacters = async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT id, name, class AS character_class, level, experience, gold, stat_points,
              fuerza, agilidad, inteligencia, vitalidad,
              hp_current, hp_max, mp_current, mp_max, faction, pos_x, pos_y 
       FROM characters 
       WHERE user_id = $1 
       ORDER BY created_at ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener personajes:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Crear un nuevo personaje
exports.createCharacter = async (req, res) => {
  const { name, characterClass } = req.body;
  const userId = req.user.userId;

  const validClasses = ['Guerrero', 'Mago', 'Cazador', 'Asesino'];
  if (!name || !characterClass || !validClasses.includes(characterClass)) {
    return res.status(400).json({ error: 'Nombre o clase inválida (Clases: Guerrero, Mago, Cazador, Asesino)' });
  }

  try {
    // Verificar que el nombre no esté registrado
    const existingName = await db.query('SELECT id FROM characters WHERE name = $1', [name]);
    if (existingName.rows.length > 0) {
      return res.status(400).json({ error: 'El nombre del personaje ya existe' });
    }

    // Atributos base según la clase (Estilo Diablo)
    let fuerza = 15, agilidad = 15, inteligencia = 15, vitalidad = 15;
    if (characterClass === 'Guerrero') { fuerza = 20; vitalidad = 20; }
    if (characterClass === 'Mago') { inteligencia = 22; agilidad = 10; }
    if (characterClass === 'Cazador') { agilidad = 20; fuerza = 15; }
    if (characterClass === 'Asesino') { agilidad = 22; fuerza = 16; }

    const newChar = await db.query(
      `INSERT INTO characters (user_id, name, class, fuerza, agilidad, inteligencia, vitalidad)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [userId, name, characterClass, fuerza, agilidad, inteligencia, vitalidad]
    );

    res.status(201).json({
      message: 'Personaje creado con éxito',
      character: newChar.rows[0]
    });
  } catch (error) {
    console.error('Error al crear personaje:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};