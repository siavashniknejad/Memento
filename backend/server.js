// Memento backend
//
// Three jobs now:
// 1. Serve the frontend (index.html, manifest.json, sw.js, icons) as
//    static files, from the SAME server and domain as the API — this
//    is what lets frontend + backend live together on apollo11 instead
//    of frontend being on GitHub Pages and backend somewhere else.
// 2. Hold the OpenAI API key privately and proxy word-lookup requests
//    (the original reason this server exists — see /define below).
// 3. Store users, decks, and cards in Postgres, so data survives across
//    devices instead of living only in one phone's browser storage.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const pool = require('./db');
const { signToken, requireAuth } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

// Serves everything in the public/ folder (index.html, manifest.json,
// sw.js, icon-192.png, icon-512.png) at the root of this same domain.
// A request to / with no matching static file falls through to the
// routes below, so this never conflicts with the API endpoints.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Set it in a .env file (see .env.example).');
  process.exit(1);
}

// Health check moved from "/" to "/healthz" — "/" is now the app itself
// (served by express.static above, via public/index.html).
app.get('/healthz', function (req, res) {
  res.send('Memento backend is running.');
});

// ===================================================================
// AUTH
// ===================================================================

app.post('/auth/register', async function (req, res) {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, passwordHash]
    );

    const userId = result.rows[0].id;
    const token = signToken(userId);
    res.status(201).json({ token: token });

  } catch (error) {
    // Postgres error code 23505 = unique constraint violation (duplicate email)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/auth/login', async function (req, res) {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  try {
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user.id);
    res.json({ token: token });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ===================================================================
// DECKS
// (every route below requireAuth() runs first — req.userId is available)
// ===================================================================

app.get('/decks', requireAuth, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT d.id, d.name, d.created_at, COUNT(c.id)::int AS card_count
       FROM decks d
       LEFT JOIN cards c ON c.deck_id = d.id
       WHERE d.user_id = $1
       GROUP BY d.id
       ORDER BY d.created_at ASC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List decks error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/decks', requireAuth, async function (req, res) {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Deck name is required.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO decks (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [req.userId, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create deck error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/decks/:id', requireAuth, async function (req, res) {
  try {
    // WHERE user_id = $2 ensures you can only delete your OWN decks —
    // without this check, anyone with any valid token could delete
    // anyone else's deck just by guessing an id.
    const result = await pool.query(
      'DELETE FROM decks WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deck not found.' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Delete deck error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ===================================================================
// CARDS
// ===================================================================

// Small helper: confirms a deck belongs to the logged-in user before
// we let them touch its cards. Reused by several routes below.
async function userOwnsDeck(deckId, userId) {
  const result = await pool.query('SELECT id FROM decks WHERE id = $1 AND user_id = $2', [deckId, userId]);
  return result.rows.length > 0;
}

app.get('/decks/:deckId/cards', requireAuth, async function (req, res) {
  const deckId = req.params.deckId;

  const owns = await userOwnsDeck(deckId, req.userId);
  if (!owns) {
    return res.status(404).json({ error: 'Deck not found.' });
  }

  try {
    const result = await pool.query('SELECT * FROM cards WHERE deck_id = $1 ORDER BY created_at ASC', [deckId]);
    res.json(result.rows);
  } catch (error) {
    console.error('List cards error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/decks/:deckId/cards', requireAuth, async function (req, res) {
  const deckId = req.params.deckId;
  const front = (req.body.front || '').trim();
  const back = (req.body.back || '').trim();
  const example = (req.body.example || '').trim() || null;

  if (!front || !back) {
    return res.status(400).json({ error: 'Both front and back are required.' });
  }

  const owns = await userOwnsDeck(deckId, req.userId);
  if (!owns) {
    return res.status(404).json({ error: 'Deck not found.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO cards (deck_id, front, back, example)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [deckId, front, back, example]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create card error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.put('/cards/:id', requireAuth, async function (req, res) {
  const front = (req.body.front || '').trim();
  const back = (req.body.back || '').trim();
  const example = (req.body.example || '').trim() || null;

  if (!front || !back) {
    return res.status(400).json({ error: 'Both front and back are required.' });
  }

  try {
    // The join through decks confirms ownership in one query — a card
    // only updates if its deck belongs to the requesting user.
    const result = await pool.query(
      `UPDATE cards SET front = $1, back = $2, example = $3
       FROM decks
       WHERE cards.id = $4
         AND cards.deck_id = decks.id
         AND decks.user_id = $5
       RETURNING cards.*`,
      [front, back, example, req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update card error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/cards/:id', requireAuth, async function (req, res) {
  try {
    const result = await pool.query(
      `DELETE FROM cards USING decks
       WHERE cards.id = $1
         AND cards.deck_id = decks.id
         AND decks.user_id = $2
       RETURNING cards.id`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found.' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Delete card error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Records a review answer (SM-2 scheduling) — mirrors the logic that
// used to run entirely in the browser's JavaScript.
app.patch('/cards/:id/review', requireAuth, async function (req, res) {
  const knewIt = req.body.knewIt === true;

  try {
    const cardResult = await pool.query(
      `SELECT cards.* FROM cards
       JOIN decks ON cards.deck_id = decks.id
       WHERE cards.id = $1 AND decks.user_id = $2`,
      [req.params.id, req.userId]
    );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found.' });
    }

    const card = cardResult.rows[0];
    let repetitions = card.repetitions;
    let easeFactor = card.ease_factor;
    let interval = card.interval;

    if (!knewIt) {
      repetitions = 0;
      interval = 1;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
    } else {
      repetitions += 1;
      if (repetitions === 1) {
        interval = 1;
      } else if (repetitions === 2) {
        interval = 6;
      } else {
        interval = Math.round(interval * easeFactor);
      }
      easeFactor = easeFactor + 0.1;
    }

    const updateResult = await pool.query(
      `UPDATE cards
       SET repetitions = $1, ease_factor = $2, interval = $3, due_date = now() + ($3 || ' days')::interval
       WHERE id = $4
       RETURNING *`,
      [repetitions, easeFactor, interval, card.id]
    );

    res.json(updateResult.rows[0]);
  } catch (error) {
    console.error('Review card error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ===================================================================
// WORD LOOKUP
//
// The example (and synonyms) are generated in the SAME language as the
// input word itself, not hardcoded to English — otherwise a lookup for
// a foreign word (e.g. a Spanish deck) got an English definition sentence
// as its "example", which is useless for practicing the actual word in
// context. Fixed 2026-09-02.
// ===================================================================

app.post('/define', async function (req, res) {
  const word = (req.body.word || '').trim();

  if (word === '') {
    return res.status(400).json({ error: 'Missing "word" in request body.' });
  }

  try {
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You help build flashcards for foreign-language vocabulary learning. ' +
              'Given a single word or short phrase, first figure out what language it is ' +
              'written in — that is the "source language" of this word (it may be English ' +
              'or any other language). ' +
              'Reply with STRICT JSON containing EXACTLY these fields, no extra text and no extra fields: ' +
              '{"word": "...", "definition": "...", "example": "...", ' +
              '"partOfSpeech": "...", "level": "...", "synonyms": ["...", "..."]}. ' +
              '- word: the exact word or phrase given by the user. ' +
              '- definition: one clear, concise English translation or definition of the word, ' +
              '1-2 sentences, suitable for a vocabulary learner. Always write this in English, ' +
              'no matter what the source language of the word is. ' +
              '- example: one natural, realistic example sentence that demonstrates the actual ' +
              'meaning of the word, written IN THE SOURCE LANGUAGE OF THE WORD ITSELF — the same ' +
              'language as the "word" field, NOT translated into English. For example, if the word ' +
              'is Spanish, the example sentence must be a real Spanish sentence using that word; ' +
              'only write the example in English if the word itself is English. ' +
              '- partOfSpeech: the most appropriate part of speech ' +
              '(e.g. noun, verb, adjective, adverb, preposition, phrasal verb). ' +
              '- level: the CEFR difficulty level, one of A1, A2, B1, B2, C1, C2 — ' +
              'choose the most appropriate level for a language learner. ' +
              '- synonyms: an array of 2-4 useful, common synonyms, in the SAME source language ' +
              'as the word (not English translations, unless the word itself is English). ' +
              'Use an empty array if none are useful.'
          },
          { role: 'user', content: word }
        ],
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('OpenAI error:', errorText);
      return res.status(502).json({ error: 'OpenAI request failed.' });
    }

    const data = await openaiResponse.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    // Validate before sending to the frontend — never trust the model's
    // output shape blindly. Fall back to safe defaults for anything
    // missing or malformed rather than letting a bad response through.
    const result = {
      word: typeof parsed.word === 'string' && parsed.word.trim() !== '' ? parsed.word : word,
      definition: typeof parsed.definition === 'string' ? parsed.definition : '',
      example: typeof parsed.example === 'string' ? parsed.example : '',
      partOfSpeech: typeof parsed.partOfSpeech === 'string' ? parsed.partOfSpeech : '',
      level: typeof parsed.level === 'string' ? parsed.level : '',
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms.filter(function (s) { return typeof s === 'string'; }) : []
    };

    res.json(result);

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.listen(PORT, function () {
  console.log('Memento backend listening on port ' + PORT);
});