const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// POST /chats — create a direct (1:1) or group chat.
// body: { isGroup: bool, name?: string, memberUsernames: string[] }
router.post('/', async (req, res) => {
  const { isGroup = false, name, memberUsernames = [] } = req.body || {};
  const creatorId = req.user.id;

  if (isGroup && (!name || name.trim() === '')) {
    return res.status(400).json({ error: 'الرجاء إدخال اسم المجموعة' });
  }
  if (!isGroup && memberUsernames.length !== 1) {
    return res.status(400).json({ error: 'المحادثة الفردية تحتاج مستخدم واحد بالضبط' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const membersResult = await client.query(
      `SELECT id, username FROM users WHERE username = ANY($1::text[]) AND status = 'approved'`,
      [memberUsernames]
    );
    if (membersResult.rowCount !== memberUsernames.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'أحد المستخدمين غير موجود أو غير معتمد' });
    }

    const chatResult = await client.query(
      `INSERT INTO chats (is_group, name, created_by) VALUES ($1, $2, $3) RETURNING id, is_group, name, created_at`,
      [isGroup, isGroup ? name.trim() : null, creatorId]
    );
    const chat = chatResult.rows[0];

    const allMemberIds = [creatorId, ...membersResult.rows.map((u) => u.id)];
    for (const userId of allMemberIds) {
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)`,
        [chat.id, userId, userId === creatorId && isGroup ? 'owner' : 'member']
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ chat });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /chats               -> normal sidebar: not archived, not hidden
// GET /chats?view=archived -> archived-chats screen
// GET /chats?view=hidden   -> hidden-chats screen (so they can be un-hidden)
router.get('/', async (req, res) => {
  const view = req.query.view;
  let whereClause = 'WHERE COALESCE(s.hidden, false) = false AND COALESCE(s.archived, false) = false';
  if (view === 'archived') whereClause = 'WHERE COALESCE(s.archived, false) = true AND COALESCE(s.hidden, false) = false';
  if (view === 'hidden') whereClause = 'WHERE COALESCE(s.hidden, false) = true';

  const result = await pool.query(
    `SELECT
       c.id, c.is_group, c.name, c.created_at,
       COALESCE(s.archived, false) AS archived,
       COALESCE(s.hidden, false) AS hidden,
       (cl.user_id IS NOT NULL) AS locked,
       lm.body AS last_message_body,
       lm.type AS last_message_type,
       lm.created_at AS last_message_at
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
     LEFT JOIN user_chat_state s ON s.chat_id = c.id AND s.user_id = $1
     LEFT JOIN chat_locks cl ON cl.chat_id = c.id AND cl.user_id = $1
     LEFT JOIN LATERAL (
       SELECT body, type, created_at FROM messages m
       WHERE m.chat_id = c.id AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC LIMIT 1
     ) lm ON true
     ${whereClause}
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
    [req.user.id]
  );
  res.json({ chats: result.rows });
});

// Small helper: 403 if the caller isn't a member of :chatId.
async function assertMember(chatId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId]
  );
  return r.rowCount > 0;
}

// POST /chats/:id/archive  { archived: bool }
router.post('/:id/archive', async (req, res) => {
  if (!(await assertMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'لست عضواً في هذه المحادثة' });
  }
  const archived = req.body?.archived !== false;
  await pool.query(
    `INSERT INTO user_chat_state (user_id, chat_id, archived)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET archived = $3, updated_at = now()`,
    [req.user.id, req.params.id, archived]
  );
  res.json({ message: archived ? 'تم أرشفة المحادثة' : 'تمت استعادة المحادثة' });
});

// POST /chats/:id/hide
router.post('/:id/hide', async (req, res) => {
  if (!(await assertMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'لست عضواً في هذه المحادثة' });
  }
  const hidden = req.body?.hidden !== false;
  await pool.query(
    `INSERT INTO user_chat_state (user_id, chat_id, hidden)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET hidden = $3, updated_at = now()`,
    [req.user.id, req.params.id, hidden]
  );
  res.json({ message: hidden ? 'تم إخفاء المحادثة' : 'تم إظهار المحادثة' });
});

// POST /chats/:id/lock  { passcode: string }
// Sets/replaces a per-user passcode. Only the calling user is affected —
// this does NOT lock the chat for other members (unlike the prototype).
router.post('/:id/lock', async (req, res) => {
  if (!(await assertMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'لست عضواً في هذه المحادثة' });
  }
  const { passcode } = req.body || {};
  if (!passcode || passcode.trim() === '') {
    return res.status(400).json({ error: 'الرجاء إدخال رمز مرور' });
  }
  const passcodeHash = await bcrypt.hash(passcode, 10);
  await pool.query(
    `INSERT INTO chat_locks (user_id, chat_id, passcode_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET passcode_hash = $3`,
    [req.user.id, req.params.id, passcodeHash]
  );
  res.json({ message: 'تم قفل المحادثة بنجاح' });
});

// POST /chats/:id/unlock  { passcode: string }
router.post('/:id/unlock', async (req, res) => {
  const { passcode } = req.body || {};
  const result = await pool.query(
    'SELECT passcode_hash FROM chat_locks WHERE user_id = $1 AND chat_id = $2',
    [req.user.id, req.params.id]
  );
  if (result.rowCount === 0) {
    return res.json({ unlocked: true }); // not locked for this user
  }
  const ok = await bcrypt.compare(passcode || '', result.rows[0].passcode_hash);
  if (!ok) {
    return res.status(401).json({ error: 'رمز المرور غير صحيح' });
  }
  res.json({ unlocked: true });
});

module.exports = router;
