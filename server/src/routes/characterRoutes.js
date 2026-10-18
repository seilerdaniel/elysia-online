const express = require('express');
const router = express.Router();
const characterController = require('../controllers/characterController');
const authMiddleware = require('../middlewares/authMiddleware');

router.get('/', authMiddleware, characterController.getCharacters);
router.post('/', authMiddleware, characterController.createCharacter);

module.exports = router;