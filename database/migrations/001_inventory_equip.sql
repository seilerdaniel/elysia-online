-- =============================================================================
-- MIGRACIÓN 001 — Inventario: casillero único por personaje y equipamiento
-- =============================================================================
-- Objetivo (Módulo C):
--   1. Impedir que dos ítems ocupen el mismo casillero de mochila.
--   2. Permitir slot_index NULL para los ítems EQUIPADOS: viven en el paperdoll,
--      no en la mochila. En PostgreSQL los NULL no colisionan entre sí en un
--      UNIQUE, así que un personaje puede tener varios ítems equipados.
--      El CHECK existente (slot_index >= 0 AND slot_index < 30) evalúa NULL y
--      por lo tanto también acepta los ítems equipados.
-- Idempotente: puede ejecutarse varias veces sin error.
-- =============================================================================

-- 1. Unicidad del casillero de mochila por personaje
DO $$ BEGIN
    ALTER TABLE inventory_items
        ADD CONSTRAINT uq_character_slot UNIQUE (character_id, slot_index);
EXCEPTION
    WHEN duplicate_object THEN null;
    -- Un UNIQUE crea además una relación de índice: si ya existe, el error es 42P07
    WHEN duplicate_table THEN null;
END $$;

-- 2. Los ítems equipados se salen de la mochila (slot_index NULL)
ALTER TABLE inventory_items ALTER COLUMN slot_index DROP NOT NULL;

-- 3. Normalizar filas ya existentes que estuvieran marcadas como equipadas
UPDATE inventory_items SET slot_index = NULL WHERE is_equipped = TRUE AND slot_index IS NOT NULL;
