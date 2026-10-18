-- =============================================================================
-- ESQUEMA DE BASE DE DATOS LOCAL (PostgreSQL) - ELYSIA ONLINE
-- MMORPG 2D Pixel Art en Navegador
-- Híbrido: Argentum Online + MU Online + Diablo + Lineage 2
-- =============================================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- 1. TABLA DE CUENTAS DE USUARIO Y ESTADO VIP
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_vip BOOLEAN DEFAULT FALSE,
    vip_expires_at TIMESTAMP WITH TIME ZONE,
    coins_premium INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 2. TABLA DE ALIANZAS Y CLANES (Estilo Lineage 2)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alliances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    tag VARCHAR(5) UNIQUE NOT NULL,
    leader_id UUID, -- Se relaciona con characters
    alliance_id UUID REFERENCES alliances(id) ON DELETE SET NULL,
    level INT DEFAULT 1,
    experience BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 3. TABLA DE PERSONAJES (Estilo Argentum Online + Diablo)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE character_class AS ENUM ('Guerrero', 'Mago', 'Cazador', 'Asesino');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE faction_type AS ENUM ('Ciudadano', 'Renegado', 'Neutral');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS characters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(30) UNIQUE NOT NULL,
    class character_class NOT NULL,
    level INT DEFAULT 1,
    experience BIGINT DEFAULT 0,
    gold BIGINT DEFAULT 0,
    
    -- Atributos de Puntos (Diablo)
    stat_points INT DEFAULT 0,
    fuerza INT DEFAULT 15,
    agilidad INT DEFAULT 15,
    inteligencia INT DEFAULT 15,
    vitalidad INT DEFAULT 15,

    -- Estado y Facciones (Argentum Online)
    hp_current INT DEFAULT 100,
    hp_max INT DEFAULT 100,
    mp_current INT DEFAULT 50,
    mp_max INT DEFAULT 50,
    karma INT DEFAULT 0,
    faction faction_type DEFAULT 'Neutral',

    -- Pertenencia a Clan
    clan_id UUID REFERENCES clans(id) ON DELETE SET NULL,
    clan_rank VARCHAR(20) DEFAULT 'Miembro',

    -- Posición en el Mundo (Mapa 2D)
    map_id INT DEFAULT 1,
    pos_x INT DEFAULT 50,
    pos_y INT DEFAULT 50,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Asignar FK de líder de clan hacia personaje
DO $$ BEGIN
    ALTER TABLE clans ADD CONSTRAINT fk_clan_leader FOREIGN KEY (leader_id) REFERENCES characters(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- -----------------------------------------------------------------------------
-- 4. PLANTILLAS E INVENTARIO DE ÍTEMS (+1 a +15 Estilo MU Online)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE item_type AS ENUM ('Arma', 'Armadura', 'Escudo', 'Casco', 'Alas', 'Gema', 'Pocion');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS item_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type item_type NOT NULL,
    sprite_id VARCHAR(100) NOT NULL, -- Referencia para el cliente Pixel Art
    req_level INT DEFAULT 1,
    req_fuerza INT DEFAULT 0,
    req_agilidad INT DEFAULT 0,
    req_inteligencia INT DEFAULT 0,
    base_damage_min INT DEFAULT 0,
    base_damage_max INT DEFAULT 0,
    base_defense INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    item_template_id INT NOT NULL REFERENCES item_templates(id) ON DELETE RESTRICT,
    
    -- Mecánica MU Online (+0 a +15)
    enhance_level INT DEFAULT 0 CHECK (enhance_level >= 0 AND enhance_level <= 15),
    
    -- Mecánica Diablo (Atributos Aleatorios en formato JSONB)
    bonus_attributes JSONB DEFAULT '{}'::jsonb,
    
    is_equipped BOOLEAN DEFAULT FALSE,
    -- slot_index NULL = ítem equipado (vive en el paperdoll, no en la mochila)
    slot_index INT CHECK (slot_index >= 0 AND slot_index < 30),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Un solo ítem por casillero de mochila (los equipados tienen slot_index NULL y no colisionan)
DO $$ BEGIN
    ALTER TABLE inventory_items
        ADD CONSTRAINT uq_character_slot UNIQUE (character_id, slot_index);
EXCEPTION
    WHEN duplicate_object THEN null;
    WHEN duplicate_table THEN null;
END $$;

-- ÍNDICES PARA OPTIMIZAR CONSULTAS EN TIEMPO REAL
CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_character ON inventory_items(character_id);
CREATE INDEX IF NOT EXISTS idx_characters_clan ON characters(clan_id);
