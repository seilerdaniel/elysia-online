const db = require('../config/db');

// --- Reglas del clan (Módulo H) -----------------------------------------------
// Fundar un clan es cosa de personajes con recorrido: pide nivel y oro. El nivel y
// el oro se leen con la fila bloqueada, así que dos peticiones simultáneas no
// pueden fundar dos clanes con el mismo dinero.
//
// Este módulo solo habla con PostgreSQL y devuelve un veredicto. Quien avisa a los
// clientes es index.js: aquí no se conoce ningún socket.

const CLAN_CREATE_LEVEL = 20;
const CLAN_CREATE_COST = 10000;
const CLAN_MAX_MEMBERS = 30;

const RANK_LEADER = 'Líder';
const RANK_OFFICER = 'Oficial';
const RANK_MEMBER = 'Miembro';

const CLAN_NAME_MIN = 3;
const CLAN_NAME_MAX = 20;

// Miembros del clan, con el líder y los oficiales primero
const MEMBER_QUERY = `
  SELECT c.id, c.name, c.level, c.class AS character_class, c.clan_rank
    FROM characters c
   WHERE c.clan_id = $1
   ORDER BY CASE c.clan_rank
              WHEN 'Líder' THEN 0
              WHEN 'Oficial' THEN 1
              ELSE 2
            END,
            c.name ASC`;

function fail(text) {
  return { ok: false, text };
}

// La etiqueta del clan es una columna única y obligatoria, pero el jugador solo
// elige el nombre: se recorta del nombre y, si está cogida, se prueba más larga.
function tagCandidates(name) {
  const clean = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const short = clean.slice(0, 3) || 'CLA';

  return [short, clean.slice(0, 4), clean.slice(0, 5)];
}

async function findFreeTag(client, name) {
  for (const candidate of tagCandidates(name)) {
    if (candidate.length < 3) continue;

    const taken = await client.query('SELECT 1 FROM clans WHERE tag = $1', [candidate]);
    if (taken.rows.length === 0) return candidate.slice(0, 5);
  }

  // Último recurso: cualquier hueco de tres caracteres
  for (let i = 0; i < 100; i += 1) {
    const candidate = `C${String(i).padStart(2, '0')}`;

    const taken = await client.query('SELECT 1 FROM clans WHERE tag = $1', [candidate]);
    if (taken.rows.length === 0) return candidate;
  }

  return null;
}

// Funda un clan y cobra la fundación. El creador queda como líder.
async function createClan({ characterId, name }) {
  const clanName = String(name || '').trim();

  if (clanName.length < CLAN_NAME_MIN || clanName.length > CLAN_NAME_MAX) {
    return fail(`El nombre del clan debe tener entre ${CLAN_NAME_MIN} y ${CLAN_NAME_MAX} caracteres.`);
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const row = await client.query(
      'SELECT level, gold, clan_id FROM characters WHERE id = $1 FOR UPDATE',
      [characterId]
    );

    if (row.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail('No encontramos tu personaje.');
    }

    const character = row.rows[0];

    if (character.clan_id) {
      await client.query('ROLLBACK');
      return fail('Ya perteneces a un clan: sal del actual antes de fundar otro.');
    }

    if (Number(character.level) < CLAN_CREATE_LEVEL) {
      await client.query('ROLLBACK');
      return fail(`Fundar un clan exige nivel ${CLAN_CREATE_LEVEL}.`);
    }

    if (Number(character.gold) < CLAN_CREATE_COST) {
      await client.query('ROLLBACK');
      return fail(`Fundar un clan cuesta ${CLAN_CREATE_COST} de oro.`);
    }

    const repeated = await client.query(
      'SELECT 1 FROM clans WHERE lower(name) = lower($1)',
      [clanName]
    );

    if (repeated.rows.length > 0) {
      await client.query('ROLLBACK');
      return fail('Ya existe un clan con ese nombre.');
    }

    const tag = await findFreeTag(client, clanName);

    if (!tag) {
      await client.query('ROLLBACK');
      return fail('No hay etiquetas libres para ese nombre. Prueba con otro.');
    }

    const created = await client.query(
      'INSERT INTO clans (name, tag, leader_id) VALUES ($1, $2, $3) RETURNING id, name, tag, level',
      [clanName, tag, characterId]
    );

    await client.query(
      `UPDATE characters
          SET clan_id = $1, clan_rank = $2, gold = gold - $3
        WHERE id = $4`,
      [created.rows[0].id, RANK_LEADER, CLAN_CREATE_COST, characterId]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      clan: { ...created.rows[0], rank: RANK_LEADER },
      cost: CLAN_CREATE_COST
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ya revertida */ }

    console.error('⚠️ No se pudo fundar el clan:', error.message);
    return fail('No se pudo fundar el clan. Inténtalo de nuevo.');
  } finally {
    client.release();
  }
}

// Invita a un personaje. La invitación se guarda aunque esté desconectado: la verá
// al entrar.
async function inviteToClan({ characterId, targetName }) {
  const wanted = String(targetName || '').trim();

  if (!wanted) return fail('Dime a quién quieres invitar.');

  const inviter = (await db.query(
    'SELECT clan_id, clan_rank FROM characters WHERE id = $1',
    [characterId]
  )).rows[0];

  if (!inviter) return fail('No encontramos tu personaje.');
  if (!inviter.clan_id) return fail('No perteneces a ningún clan.');
  if (inviter.clan_rank !== RANK_LEADER && inviter.clan_rank !== RANK_OFFICER) {
    return fail('Solo el líder y los oficiales pueden invitar.');
  }

  const target = (await db.query(
    'SELECT id, name, clan_id FROM characters WHERE lower(name) = lower($1)',
    [wanted]
  )).rows[0];

  if (!target) return fail(`No existe ningún personaje llamado ${wanted}.`);
  if (target.id === characterId) return fail('No puedes invitarte a ti mismo.');
  if (target.clan_id) return fail(`${target.name} ya pertenece a un clan.`);

  const clan = (await db.query('SELECT name FROM clans WHERE id = $1', [inviter.clan_id])).rows[0];

  if (!clan) return fail('Tu clan ya no existe.');

  const total = (await db.query(
    'SELECT count(*)::int AS total FROM characters WHERE clan_id = $1',
    [inviter.clan_id]
  )).rows[0].total;

  if (total >= CLAN_MAX_MEMBERS) {
    return fail(`El clan ya tiene ${CLAN_MAX_MEMBERS} miembros.`);
  }

  await db.query(
    `INSERT INTO clan_invites (clan_id, character_id, invited_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (clan_id, character_id)
     DO UPDATE SET invited_by = EXCLUDED.invited_by, created_at = CURRENT_TIMESTAMP`,
    [inviter.clan_id, target.id, characterId]
  );

  return { ok: true, targetId: target.id, targetName: target.name, clanName: clan.name };
}

// Acepta la invitación pendiente y mete al personaje en el clan como miembro
async function acceptInvite({ characterId, clanId }) {
  const invite = (await db.query(
    `SELECT i.clan_id, cl.name AS clan_name
       FROM clan_invites i
       JOIN clans cl ON cl.id = i.clan_id
      WHERE i.character_id = $1 AND ($2::uuid IS NULL OR i.clan_id = $2::uuid)
      ORDER BY i.created_at DESC
      LIMIT 1`,
    [characterId, clanId || null]
  )).rows[0];

  if (!invite) return fail('No tienes ninguna invitación pendiente.');

  const character = (await db.query(
    'SELECT clan_id FROM characters WHERE id = $1',
    [characterId]
  )).rows[0];

  if (!character) return fail('No encontramos tu personaje.');

  if (character.clan_id) {
    await db.query('DELETE FROM clan_invites WHERE character_id = $1', [characterId]);
    return fail('Ya perteneces a un clan.');
  }

  // El clan pudo llenarse mientras la invitación esperaba
  const total = (await db.query(
    'SELECT count(*)::int AS total FROM characters WHERE clan_id = $1',
    [invite.clan_id]
  )).rows[0].total;

  if (total >= CLAN_MAX_MEMBERS) {
    await db.query('DELETE FROM clan_invites WHERE character_id = $1', [characterId]);
    return fail('Ese clan ya está completo.');
  }

  await db.query(
    'UPDATE characters SET clan_id = $1, clan_rank = $2 WHERE id = $3',
    [invite.clan_id, RANK_MEMBER, characterId]
  );

  await db.query('DELETE FROM clan_invites WHERE character_id = $1', [characterId]);

  return { ok: true, clanId: invite.clan_id, clanName: invite.clan_name };
}

// Salir del clan. El líder no puede dejarlo vacío: para cerrarlo hay que disolverlo.
async function leaveClan({ characterId }) {
  const character = (await db.query(
    'SELECT clan_id, clan_rank FROM characters WHERE id = $1',
    [characterId]
  )).rows[0];

  if (!character || !character.clan_id) return fail('No perteneces a ningún clan.');

  if (character.clan_rank === RANK_LEADER) {
    return fail('El líder no puede abandonar el clan: para cerrarlo hay que disolverlo.');
  }

  await db.query(
    'UPDATE characters SET clan_id = NULL, clan_rank = $1 WHERE id = $2',
    [RANK_MEMBER, characterId]
  );

  await db.query('DELETE FROM clan_invites WHERE character_id = $1', [characterId]);

  return { ok: true, clanId: character.clan_id };
}

// Expulsa a un miembro. El líder manda sobre todos; un oficial solo sobre miembros.
async function kickFromClan({ characterId, targetName }) {
  const wanted = String(targetName || '').trim();

  if (!wanted) return fail('Dime a quién quieres expulsar.');

  const actor = (await db.query(
    'SELECT clan_id, clan_rank FROM characters WHERE id = $1',
    [characterId]
  )).rows[0];

  if (!actor || !actor.clan_id) return fail('No perteneces a ningún clan.');
  if (actor.clan_rank === RANK_MEMBER) {
    return fail('Solo el líder y los oficiales pueden expulsar.');
  }

  const target = (await db.query(
    'SELECT id, name, clan_id, clan_rank FROM characters WHERE lower(name) = lower($1)',
    [wanted]
  )).rows[0];

  if (!target) return fail(`No existe ningún personaje llamado ${wanted}.`);
  if (target.clan_id !== actor.clan_id) return fail(`${target.name} no está en tu clan.`);
  if (target.clan_rank === RANK_LEADER) return fail('No se puede expulsar al líder.');
  if (target.clan_rank === RANK_OFFICER && actor.clan_rank !== RANK_LEADER) {
    return fail('Solo el líder puede expulsar a un oficial.');
  }

  await db.query(
    'UPDATE characters SET clan_id = NULL, clan_rank = $1 WHERE id = $2',
    [RANK_MEMBER, target.id]
  );

  await db.query('DELETE FROM clan_invites WHERE character_id = $1', [target.id]);

  return { ok: true, clanId: actor.clan_id, targetId: target.id, targetName: target.name };
}

// Disuelve el clan. La FK ON DELETE SET NULL de characters.clan_id deja a todos los
// miembros sin clan, y las invitaciones caen con el clan.
async function dissolveClan({ characterId }) {
  const actor = (await db.query(
    'SELECT clan_id, clan_rank FROM characters WHERE id = $1',
    [characterId]
  )).rows[0];

  if (!actor || !actor.clan_id) return fail('No perteneces a ningún clan.');
  if (actor.clan_rank !== RANK_LEADER) return fail('Solo el líder puede disolver el clan.');

  const clan = (await db.query('SELECT name FROM clans WHERE id = $1', [actor.clan_id])).rows[0];

  await db.query(
    'UPDATE characters SET clan_rank = $1 WHERE clan_id = $2',
    [RANK_MEMBER, actor.clan_id]
  );

  await db.query('DELETE FROM clans WHERE id = $1', [actor.clan_id]);

  return { ok: true, clanId: actor.clan_id, clanName: clan ? clan.name : 'el clan' };
}

// Ficha del clan con sus miembros. Los que están en línea los marca index.js, que es
// quien conoce las sesiones abiertas.
async function getClanState({ clanId, characterId }) {
  if (!clanId) return { ok: true, clan: null, members: [] };

  const clan = (await db.query(
    'SELECT id, name, tag, level, experience FROM clans WHERE id = $1',
    [clanId]
  )).rows[0];

  if (!clan) return { ok: true, clan: null, members: [] };

  const members = await db.query(MEMBER_QUERY, [clanId]);
  const mine = members.rows.find((member) => member.id === characterId);

  return {
    ok: true,
    clan: { ...clan, rank: mine ? mine.clan_rank : null },
    members: members.rows.map((member) => ({
      characterId: member.id,
      name: member.name,
      level: member.level,
      characterClass: member.character_class,
      rank: member.clan_rank
    }))
  };
}

// Invitaciones esperando respuesta
async function pendingInvites(characterId) {
  const result = await db.query(
    `SELECT i.clan_id, cl.name AS clan_name
       FROM clan_invites i
       JOIN clans cl ON cl.id = i.clan_id
      WHERE i.character_id = $1
      ORDER BY i.created_at DESC`,
    [characterId]
  );

  return result.rows.map((row) => ({ clanId: row.clan_id, clanName: row.clan_name }));
}

module.exports = {
  CLAN_CREATE_LEVEL,
  CLAN_CREATE_COST,
  CLAN_MAX_MEMBERS,
  RANK_LEADER,
  RANK_OFFICER,
  RANK_MEMBER,
  createClan,
  inviteToClan,
  acceptInvite,
  leaveClan,
  kickFromClan,
  dissolveClan,
  getClanState,
  pendingInvites
};
