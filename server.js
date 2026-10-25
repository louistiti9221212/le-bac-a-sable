"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ALPHA BLITZ" });
});

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      )
    : null;

if (!supabase) {
  console.warn("Supabase absent : les données ne seront pas persistées.");
}

const CATEGORIES = [
  "Prénom féminin", "Prénom masculin", "Pays", "Ville",
  "Capitale", "Animal", "Fruit", "Légume", "Fleur", "Métier",
  "Marque", "Objet du quotidien", "Couleur", "Vêtement", "Sport",
  "Loisir", "Instrument de musique", "Plat", "Boisson", "Film",
  "Série", "Jeu vidéo", "Personnage fictif", "Célébrité",
  "Véhicule", "Matière scolaire", "Matériau",
  "Partie du corps", "Émotion"
];

const THEMES_PER_ROUND = 8;
const SPIN_TIMEOUT = 10000;
const NEXT_SPIN_DELAY = 3200;
const COUNTDOWN_MS = 3000;
const VOTE_STEP_TIMEOUT = 25000;
const MAX_PLAYERS = 8;
const START_COINS = 50;
const ROUND_BONUS_COINS = 10;
const FINISH_BONUS_COINS = 20;
const MAX_INVENTORY = 2;

const LETTERS = "ABCDEFGHJKLMNOPRSTV";

const MONSTER_IDS = [
  "blobito", "flamby", "cyclopi", "piquito", "touffu", "ombrix",
  "voltix", "goutti", "rococo", "fantomix", "zouzou", "arc-en-boum"
];

const ACCESSORIES = [
  "none", "crown", "glasses", "hat", "star",
  "pizza", "birthday", "bcdshirt"
];

const COSMETICS = [
  { id: "crown", name: "Couronne", price: 0 },
  { id: "glasses", name: "Lunettes", price: 0 },
  { id: "hat", name: "Chapeau", price: 0 },
  { id: "star", name: "Étoile", price: 0 },
  { id: "pizza", name: "Pizza", price: 0 },
  { id: "birthday", name: "Chapeau d’anniversaire", price: 0 },
  { id: "bcdshirt", name: "T-shirt B C D", price: 0 }
];

const POWERS = [
  { id: "friend", name: "📞 Appel à un ami", price: 30, available: true },
  { id: "double", name: "✨ Multiplicateur", price: 55, available: true },
  { id: "time", name: "⏱️ Temps bonus", price: 65, available: true },
  { id: "spy", name: "🕵️ Espionnage", price: 70, available: true },
  { id: "shield", name: "🛡️ Bouclier", price: 75, available: true },
  { id: "change", name: "🔄 Changement de catégorie", price: 85, available: false },
  { id: "mystery", name: "🎲 Pouvoir mystère", price: 100, available: true }
];

const rooms = new Map();
const saveQueues = new Map();

const norm = value =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

const cleanName = value =>
  String(value || "Joueur")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 18) || "Joueur";

const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const randomItem = array => array[Math.floor(Math.random() * array.length)];

function safeAvatar(input, ownedCosmetics = []) {
  const avatar = input && typeof input === "object" ? input : {};
  const accessory = ACCESSORIES.includes(avatar.accessory)
    ? avatar.accessory
    : "none";

  return {
    monsterId: MONSTER_IDS.includes(avatar.monsterId)
      ? avatar.monsterId
      : "blobito",
    color: /^#[0-9a-fA-F]{6}$/.test(avatar.color || "")
      ? avatar.color
      : "#8b6cff",
    accessory
  };
}

function newPlayer(id, name, avatar, host) {
  return {
    id,
    name: cleanName(name),
    score: 0,
    coins: START_COINS,
    ready: !!host,
    host: !!host,
    avatar: safeAvatar(avatar, []),
    inventory: [],
    cosmetics: [],
    activePowers: [],
    shield: false,
    submitted: false
  };
}

function throttled(socket, key, ms) {
  const hits = socket.data.hits || (socket.data.hits = {});
  const now = Date.now();
  if (hits[key] && now - hits[key] < ms) return true;
  hits[key] = now;
  return false;
}

function sendError(socket, message) {
  socket.emit("app:error", { message });
}

function playerForSocket(room, socket) {
  return room?.players.get(socket.id);
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    coins: player.coins,
    ready: player.ready,
    host: player.host,
    avatar: player.avatar,
    inventory: player.inventory,
    cosmetics: player.cosmetics,
    submitted: player.submitted
  };
}

function roomState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    round: room.round,
    maxRounds: room.maxRounds,
    duration: room.duration,
    categories: room.categories,
    selectedThemes: room.selectedThemes || [],
    spinIndex: room.spinIndex || 0,
    spinId: room.spinId || 0,
    spinnerId: room.spinnerId || null,
    spinnerName: room.spinnerId
      ? room.players.get(room.spinnerId)?.name || null
      : null,
    letter: room.status === "playing" ? room.letter : null,
    theme: room.theme,
    deadline: room.deadline,
    now: Date.now(),
    voteIndex: room.voteIndex || 0,
    voteTotal: room.votePlayers ? room.votePlayers.length : 0,
    players: [...room.players.values()].map(publicPlayer),
    leaderboard: [...room.players.values()]
      .map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        coins: p.coins,
        avatar: p.avatar
      }))
      .sort((a, b) => b.score - a.score),
    lastResults: room.lastResults || []
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    maxRounds: room.maxRounds,
    duration: room.duration,
    categories: room.categories,
    selectedThemes: room.selectedThemes || [],
    spinIndex: room.spinIndex || 0,
    letter: room.letter,
    theme: room.theme,
    deadline: room.deadline,
    submissions: [...room.submissions.entries()],
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      coins: p.coins,
      ready: p.ready,
      host: p.host,
      avatar: p.avatar,
      inventory: p.inventory,
      cosmetics: p.cosmetics,
      activePowers: p.activePowers,
      shield: p.shield,
      submitted: p.submitted
    })),
    lastResults: room.lastResults || []
  };
}

function saveRoom(room) {
  if (!supabase || !room) return Promise.resolve();

  const snapshot = serializeRoom(room);
  const previous = saveQueues.get(room.code) || Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(async () => {
      const { error } = await supabase.from("rooms").upsert({
        code: snapshot.code,
        host_id: snapshot.hostId,
        status: snapshot.status,
        duration: snapshot.duration,
        round: snapshot.round,
        game: snapshot,
        updated_at: new Date().toISOString()
      }, { onConflict: "code" });

      if (error) throw error;

      const { error: deleteError } = await supabase
        .from("players")
        .delete()
        .eq("room_code", snapshot.code);

      if (deleteError) throw deleteError;

      if (snapshot.players.length) {
        const { error: insertError } = await supabase
          .from("players")
          .insert(snapshot.players.map(p => ({
            room_code: snapshot.code,
            player_id: p.id,
            player_name: p.name,
            score: p.score,
            connected: true
          })));

        if (insertError) throw insertError;
      }
    })
    .catch(error => console.error("Erreur Supabase :", error.message));

  saveQueues.set(room.code, current);
  return current;
}

function scheduleSave(room) {
  if (!supabase || !room || room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    if (rooms.get(room.code) === room) void saveRoom(room);
  }, 600);
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", roomState(room));
  scheduleSave(room);
}

function system(room, message) {
  io.to(room.code).emit("chat:message", {
    name: "Le jeu",
    text: message,
    system: true,
    at: Date.now()
  });

  if (supabase) {
    void supabase.from("messages").insert({
      room_code: room.code,
      player_name: "Le jeu",
      content: String(message).slice(0, 180)
    }).then(({ error }) => {
      if (error) console.error("Message Supabase :", error.message);
    });
  }
}

function stopTimers(room) {
  for (const key of [
    "timer", "countdownTimer", "rouletteTimer", "voteTimer", "nextSpinTimer"
  ]) {
    if (room[key]) clearTimeout(room[key]);
    room[key] = null;
  }
}

function chooseLetter() {
  return randomItem(LETTERS.split(""));
}

function newRoom(code, host, maxRounds, duration) {
  return {
    code,
    hostId: host.id,
    players: new Map([[host.id, host]]),
    status: "lobby",
    round: 1,
    maxRounds,
    duration,
    categories: [...CATEGORIES],
    selectedThemes: [],
    spinIndex: 0,
    spinId: 0,
    spinOrder: [],
    spinnerId: null,
    pendingTheme: null,
    letter: null,
    theme: null,
    deadline: null,
    submissions: new Map(),
    votes: new Map(),
    votePlayers: [],
    voteIndex: 0,
    timer: null,
    countdownTimer: null,
    rouletteTimer: null,
    voteTimer: null,
    nextSpinTimer: null,
    saveTimer: null,
    lastResults: []
  };
}

function purgeOfflinePlayers(room) {
  for (const id of [...room.players.keys()]) {
    if (id.startsWith("offline_")) room.players.delete(id);
  }
  if (!room.players.has(room.hostId)) {
    const next = room.players.values().next().value;
    if (next) {
      room.hostId = next.id;
      for (const p of room.players.values()) p.host = p.id === next.id;
    }
  }
}

function resetToLobby(room, message) {
  stopTimers(room);
  room.status = "lobby";
  room.round = 1;
  room.letter = null;
  room.theme = null;
  room.deadline = null;
  room.selectedThemes = [];
  room.spinnerId = null;
  room.pendingTheme = null;
  room.submissions = new Map();
  room.votes = new Map();
  room.votePlayers = [];
  room.voteIndex = 0;

  for (const p of room.players.values()) {
    p.submitted = false;
    p.ready = p.id === room.hostId;
  }

  emitRoom(room);
  if (message) system(room, message);
}

function startCountdown(room) {
  stopTimers(room);
  room.status = "countdown";
  room.letter = null;
  room.theme = null;
  room.selectedThemes = [];
  room.spinIndex = 0;
  room.spinnerId = null;
  room.pendingTheme = null;
  room.deadline = Date.now() + COUNTDOWN_MS;
  room.submissions = new Map();
  room.votes = new Map();
  room.votePlayers = [];
  room.voteIndex = 0;

  for (const p of room.players.values()) p.submitted = false;

  emitRoom(room);
  io.to(room.code).emit("game:started", {
    round: room.round,
    maxRounds: room.maxRounds,
    countdown: COUNTDOWN_MS
  });
  system(room, "La partie commence dans 3 secondes !");

  room.countdownTimer = setTimeout(() => {
    if (room.status === "countdown") startRoulette(room);
  }, COUNTDOWN_MS);
}

/* ---------- ROULETTE À 8 THÈMES ---------- */

function startRoulette(room) {
  stopTimers(room);
  room.status = "roulette";
  room.theme = null;
  room.letter = null;
  room.selectedThemes = [];
  room.spinIndex = 0;
  room.spinnerId = null;
  room.pendingTheme = null;
  room.spinOrder = [...room.players.keys()];

  emitRoom(room);
  system(room, `La roulette va sélectionner ${THEMES_PER_ROUND} thèmes !`);
  spinNextTheme(room);
}

function pickSpinner(room) {
  const order = room.spinOrder || [];
  for (let k = 0; k < order.length; k++) {
    const id = order[(room.spinIndex + k) % order.length];
    if (room.players.has(id)) {
      room.spinIndex += k;
      return room.players.get(id);
    }
  }
  return [...room.players.values()][0] || null;
}

function spinNextTheme(room) {
  if (room.status !== "roulette") return;

  if (room.rouletteTimer) clearTimeout(room.rouletteTimer);
  room.rouletteTimer = null;
  if (room.nextSpinTimer) clearTimeout(room.nextSpinTimer);
  room.nextSpinTimer = null;

  if (room.selectedThemes.length >= THEMES_PER_ROUND) {
    startAnswerRound(room);
    return;
  }

  const available = room.categories.filter(
    category => !room.selectedThemes.includes(category)
  );

  if (!available.length) {
    startAnswerRound(room);
    return;
  }

  const spinner = pickSpinner(room);
  if (!spinner) return;

  room.spinId = (room.spinId || 0) + 1;
  const spinId = room.spinId;

  room.spinnerId = spinner.id;
  room.pendingTheme = randomItem(available);

  const index = room.selectedThemes.length + 1;

  io.to(room.code).emit("roulette:start", {
    spinId,
    themes: available,
    selectedThemes: [...room.selectedThemes],
    index,
    total: THEMES_PER_ROUND,
    spinnerId: spinner.id,
    spinnerName: spinner.name,
    duration: SPIN_TIMEOUT
  });

  emitRoom(room);

  system(
    room,
    `${spinner.name} doit arrêter la roulette (${index}/${THEMES_PER_ROUND}).`
  );

  room.rouletteTimer = setTimeout(() => {
    if (room.status === "roulette" && room.spinId === spinId && room.pendingTheme) {
      acceptPendingTheme(room, true, spinId);
    }
  }, SPIN_TIMEOUT);
}

function acceptPendingTheme(room, automatic = false, spinId = undefined) {
  if (room.status !== "roulette" || !room.pendingTheme) return;
  if (spinId !== undefined && spinId !== room.spinId) return;

  if (room.rouletteTimer) clearTimeout(room.rouletteTimer);
  room.rouletteTimer = null;

  const theme = room.pendingTheme;
  room.pendingTheme = null;
  room.spinnerId = null;

  if (room.selectedThemes.includes(theme)) {
    room.spinIndex++;
    spinNextTheme(room);
    return;
  }

  room.selectedThemes.push(theme);
  room.spinIndex++;

  const index = room.selectedThemes.length;

  io.to(room.code).emit("roulette:result", {
    spinId: room.spinId,
    theme,
    index,
    total: THEMES_PER_ROUND,
    selectedThemes: [...room.selectedThemes],
    automatic
  });

  system(
    room,
    `${automatic ? "Sélection automatique" : "Thème sélectionné"} : ${theme} (${index}/${THEMES_PER_ROUND}).`
  );

  emitRoom(room);

  if (room.nextSpinTimer) clearTimeout(room.nextSpinTimer);
  room.nextSpinTimer = setTimeout(() => {
    room.nextSpinTimer = null;
    if (room.status !== "roulette") return;
    if (room.selectedThemes.length >= THEMES_PER_ROUND) startAnswerRound(room);
    else spinNextTheme(room);
  }, NEXT_SPIN_DELAY);
}

function startAnswerRound(room) {
  if (room.status !== "roulette") return;

  stopTimers(room);

  room.status = "playing";
  room.theme = null;
  room.letter = chooseLetter();
  room.deadline = Date.now() + room.duration * 1000;
  room.submissions = new Map();
  room.votes = new Map();
  room.spinnerId = null;
  room.pendingTheme = null;

  for (const p of room.players.values()) p.submitted = false;

  const categories = [...room.selectedThemes];

  io.to(room.code).emit("game:round", {
    round: room.round,
    maxRounds: room.maxRounds,
    theme: null,
    letter: room.letter,
    duration: room.duration,
    deadline: room.deadline,
    now: Date.now(),
    categories,
    selectedThemes: categories
  });

  system(
    room,
    `Les 8 thèmes sont sélectionnés ! Lettre : ${room.letter}. C'est parti !`
  );

  emitRoom(room);

  room.timer = setTimeout(
    () => finishRound(room, true),
    room.duration * 1000
  );
}

/* ---------- VOTES ET RÉSULTATS ---------- */

function activeCategories(room) {
  return room.selectedThemes?.length
    ? room.selectedThemes
    : room.categories;
}

function publicVotePlayer(room, player) {
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    answers: room.submissions.get(player.id) || {}
  };
}

function hasAnswers(room, playerId) {
  const answers = room.submissions.get(playerId) || {};
  return activeCategories(room).some(c => String(answers[c] || "").trim());
}

function setVoteTimer(room) {
  if (room.voteTimer) clearTimeout(room.voteTimer);
  const expected = room.voteIndex;
  room.voteTimer = setTimeout(
    () => advanceVote(room, expected),
    VOTE_STEP_TIMEOUT
  );
}

function startVoting(room) {
  stopTimers(room);
  room.status = "voting";
  room.votes = new Map();
  room.votePlayers = [...room.players.values()]
    .filter(p => hasAnswers(room, p.id))
    .map(p => p.id);
  room.voteIndex = 0;

  if (!room.votePlayers.length) {
    system(room, "Aucune réponse à évaluer.");
    finishVoting(room);
    return;
  }

  const players = room.votePlayers
    .map(id => room.players.get(id))
    .filter(Boolean)
    .map(p => publicVotePlayer(room, p));

  io.to(room.code).emit("vote:start", {
    players,
    player: players[0],
    index: 0,
    total: room.votePlayers.length,
    duration: VOTE_STEP_TIMEOUT
  });
  emitRoom(room);
  system(room, "La phase de vote commence !");
  setVoteTimer(room);
}

function presentVoteTarget(room) {
  const target = room.players.get(room.votePlayers[room.voteIndex]);
  if (!target) {
    finishVoting(room);
    return;
  }

  io.to(room.code).emit("vote:player", {
    player: publicVotePlayer(room, target),
    index: room.voteIndex,
    total: room.votePlayers.length,
    duration: VOTE_STEP_TIMEOUT
  });
  emitRoom(room);
  setVoteTimer(room);
}

function advanceVote(room, expectedIndex) {
  if (room.status !== "voting") return;
  if (expectedIndex !== undefined && expectedIndex !== room.voteIndex) return;

  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.voteTimer = null;

  room.voteIndex++;

  if (room.voteIndex >= room.votePlayers.length) {
    finishVoting(room);
    return;
  }

  presentVoteTarget(room);
}

function finishRound(room, timedOut = false) {
  if (room.status !== "playing") return;

  stopTimers(room);

  for (const p of room.players.values()) {
    if (!room.submissions.has(p.id)) room.submissions.set(p.id, {});
  }

  system(room, timedOut
    ? "Temps écoulé ! Place aux votes."
    : "Toutes les réponses sont envoyées ! Place aux votes."
  );

  startVoting(room);
}

function finishVoting(room) {
  if (room.status !== "voting") return;
  stopTimers(room);

  const results = [];
  const categories = activeCategories(room);

  for (const player of room.players.values()) {
    const answers = room.submissions.get(player.id) || {};
    const rows = [];
    let valid = 0;
    let earned = 0;

    for (const category of categories) {
      const word = String(answers[category] || "").trim().slice(0, 60);
      const ballot = room.votes.get(`${player.id}:${category}`) || new Map();

      const yes = [...ballot.values()].filter(v => v === "accept").length;
      const no = [...ballot.values()].filter(v => v === "reject").length;
      const accepted = Boolean(word) && yes > no;

      let points = 0;
      let coins = 0;

      if (accepted) {
        points = 10;
        valid++;
        player.score += points;

        coins = word.length >= 9 ? 12 : word.length >= 6 ? 8 : 5;
        if (player.activePowers.includes("double")) coins *= 2;

        player.coins += coins;
        earned += coins;
      }

      rows.push({
        category,
        word,
        valid: accepted,
        points,
        coins,
        votesFor: yes,
        votesAgainst: no
      });
    }

    player.activePowers = player.activePowers.filter(x => x !== "double");

    player.coins += ROUND_BONUS_COINS;
    earned += ROUND_BONUS_COINS;

    results.push({
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      valid,
      earned,
      bonus: ROUND_BONUS_COINS,
      rows
    });
  }

  room.lastResults = results;
  room.status = "results";
  room.votePlayers = [];
  room.voteIndex = 0;

  io.to(room.code).emit("round:results", {
    round: room.round,
    maxRounds: room.maxRounds,
    letter: room.letter,
    theme: room.theme,
    categories: activeCategories(room),
    results,
    state: roomState(room)
  });

  emitRoom(room);
}

function submitVote(socket, data = {}) {
  const room = rooms.get(socket.data.roomCode);
  const voter = playerForSocket(room, socket);

  if (!room || !voter || room.status !== "voting") return;

  const targetId = String(data.targetPlayerId || "");
  const category = String(data.category || "");
  const decision = data.decision;

  if (!["accept", "reject"].includes(decision)) {
    return sendError(socket, "Vote invalide.");
  }

  if (targetId === voter.id) {
    return sendError(socket, "Tu ne peux pas voter pour tes propres réponses.");
  }

  if (!room.players.has(targetId)) {
    return sendError(socket, "Joueur introuvable.");
  }

  if (room.votePlayers[room.voteIndex] !== targetId) {
    return sendError(socket, "Ce joueur n'est pas (ou plus) soumis au vote.");
  }

  if (!activeCategories(room).includes(category)) {
    return sendError(socket, "Catégorie invalide.");
  }

  const word = String(
    (room.submissions.get(targetId) || {})[category] || ""
  ).trim();

  if (!word) return sendError(socket, "Cette réponse est vide.");

  const key = `${targetId}:${category}`;
  if (!room.votes.has(key)) room.votes.set(key, new Map());

  const ballot = room.votes.get(key);

  if (ballot.has(voter.id)) {
    return sendError(socket, "Tu as déjà voté pour cette réponse.");
  }

  ballot.set(voter.id, decision);

  const yes = [...ballot.values()].filter(v => v === "accept").length;
  const no = [...ballot.values()].filter(v => v === "reject").length;

  io.to(room.code).emit("vote:update", {
    targetPlayerId: targetId,
    category,
    accept: yes,
    reject: no
  });

  scheduleSave(room);
}

/* ---------- SALONS ET JOUEURS ---------- */

function leaveRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  const player = room.players.get(socket.id);
  if (!player) return;

  const wasActiveSpinner =
    room.status === "roulette" &&
    room.spinnerId === socket.id &&
    !!room.pendingTheme;

  room.players.delete(socket.id);

  if (supabase) {
    void supabase.from("players")
      .update({ connected: false })
      .eq("room_code", roomCode)
      .eq("player_id", socket.id)
      .then(({ error }) => {
        if (error) console.error("Déconnexion :", error.message);
      });
  }

  if (!room.players.size) {
    stopTimers(room);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === socket.id) {
    const next =
      [...room.players.values()].find(p => !p.id.startsWith("offline_")) ||
      room.players.values().next().value;
    room.hostId = next.id;
    for (const p of room.players.values()) p.host = p.id === next.id;
  }

  system(room, `${player.name} a quitté la salle.`);

  const running = ["countdown", "roulette", "playing", "voting"].includes(room.status);

  if (running && room.players.size < 2) {
    resetToLobby(room, "Il ne reste plus assez de joueurs : retour au salon.");
    return;
  }

  if (wasActiveSpinner) {
    if (room.rouletteTimer) clearTimeout(room.rouletteTimer);
    room.rouletteTimer = null;
    room.pendingTheme = null;
    room.spinnerId = null;
    room.spinIndex++;
    spinNextTheme(room);
    return;
  }

  if (room.status === "playing") {
    if ([...room.players.values()].every(p => p.submitted)) {
      finishRound(room, false);
      return;
    }
  }

  if (room.status === "voting") {
    const pos = room.votePlayers.indexOf(socket.id);
    if (pos !== -1) {
      room.votePlayers.splice(pos, 1);
      if (pos < room.voteIndex) {
        room.voteIndex--;
      } else if (pos === room.voteIndex) {
        if (room.voteIndex >= room.votePlayers.length) finishVoting(room);
        else presentVoteTarget(room);
        return;
      }
    }
    if (!room.votePlayers.length) {
      finishVoting(room);
      return;
    }
  }

  emitRoom(room);
}

async function restoreRooms() {
  if (!supabase) return;

  try {
    const { data, error } = await supabase
      .from("rooms")
      .select("code, game")
      .in("status", ["lobby", "results", "finished"]);

    if (error) throw error;

    for (const row of data || []) {
      const saved = row.game;
      if (!saved?.code || !Array.isArray(saved.players) || !saved.players.length) {
        continue;
      }

      const players = new Map();
      let firstId = null;

      for (const old of saved.players) {
        const id = `offline_${crypto.randomUUID()}`;
        if (!firstId) firstId = id;

        const cosmetics = Array.isArray(old.cosmetics)
          ? old.cosmetics.filter(c => COSMETICS.some(x => x.id === c))
          : [];

        players.set(id, {
          id,
          name: cleanName(old.name),
          score: Number(old.score) || 0,
          coins: Math.max(0, Number(old.coins) || 0),
          ready: false,
          host: false,
          avatar: safeAvatar(old.avatar, cosmetics),
          inventory: Array.isArray(old.inventory)
            ? old.inventory
                .filter(p => POWERS.some(x => x.id === p))
                .slice(0, MAX_INVENTORY)
            : [],
          cosmetics,
          activePowers: Array.isArray(old.activePowers) ? old.activePowers : [],
          shield: !!old.shield,
          submitted: false
        });
      }

      const room = {
        code: saved.code,
        hostId: firstId,
        players,
        status: ["lobby", "results", "finished"].includes(saved.status)
          ? saved.status
          : "lobby",
        round: Number(saved.round) || 1,
        maxRounds: Number(saved.maxRounds) || 5,
        duration: Number(saved.duration) || 60,
        categories: Array.isArray(saved.categories)
          ? saved.categories
          : [...CATEGORIES],
        selectedThemes: Array.isArray(saved.selectedThemes)
          ? saved.selectedThemes
          : [],
        spinIndex: Number(saved.spinIndex) || 0,
        spinId: 0,
        spinOrder: [],
        spinnerId: null,
        pendingTheme: null,
        letter: saved.letter || null,
        theme: saved.theme || null,
        deadline: null,
        submissions: new Map(),
        votes: new Map(),
        votePlayers: [],
        voteIndex: 0,
        timer: null,
        countdownTimer: null,
        rouletteTimer: null,
        voteTimer: null,
        nextSpinTimer: null,
        saveTimer: null,
        lastResults: Array.isArray(saved.lastResults) ? saved.lastResults : []
      };

      for (const p of room.players.values()) p.host = p.id === room.hostId;
      rooms.set(room.code, room);
    }

    console.log(`${rooms.size} salon(s) restauré(s).`);
  } catch (error) {
    console.error("Restauration Supabase :", error.message);
  }
}

/* ---------- SOCKET.IO ---------- */

io.on("connection", socket => {
  socket.emit("game:config", {
    categories: CATEGORIES,
    powers: POWERS,
    cosmetics: COSMETICS,
    themesPerRound: THEMES_PER_ROUND
  });

  socket.on("room:create", async (data = {}) => {
    try {
      if (!data || typeof data !== "object") data = {};
      leaveRoom(socket);

      let roomCode;
      do {
        roomCode = makeCode();
      } while (rooms.has(roomCode));

      const player = newPlayer(socket.id, data.name, data.avatar, true);

      const room = newRoom(
        roomCode,
        player,
        Math.max(1, Math.min(10, Number(data.maxRounds) || 5)),
        Math.max(30, Math.min(180, Number(data.duration) || 60))
      );

      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      socket.emit("room:joined", {
        code: roomCode,
        playerId: socket.id,
        isHost: true
      });

      emitRoom(room);
      system(room, `${player.name} a créé le salon.`);
      await saveRoom(room);
    } catch (error) {
      console.error("Création :", error);
      sendError(socket, "Impossible de créer le salon.");
    }
  });

  socket.on("room:join", async (data = {}) => {
    try {
      if (!data || typeof data !== "object") data = {};
      leaveRoom(socket);

      const roomCode = String(data.code || "").trim().toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(roomCode)) {
        return sendError(socket, "Code de salon invalide.");
      }

      const room = rooms.get(roomCode);

      if (!room) return sendError(socket, "Salon introuvable.");
      if (!["lobby", "results", "finished"].includes(room.status)) {
        return sendError(socket, "La partie est en cours.");
      }

      const name = cleanName(data.name);

      const ghost = [...room.players.values()].find(
        p => p.id.startsWith("offline_") && norm(p.name) === norm(name)
      );

      if (!ghost && room.players.size >= MAX_PLAYERS) {
        return sendError(socket, "Le salon est complet.");
      }

      let player;
      if (ghost) {
        room.players.delete(ghost.id);
        player = ghost;
        player.id = socket.id;
        player.ready = false;
        player.host = false;
        player.submitted = false;
        player.avatar = safeAvatar(data.avatar, player.cosmetics);
      } else {
        player = newPlayer(socket.id, name, data.avatar, false);
      }

      room.players.set(socket.id, player);

      if (!room.players.has(room.hostId) || room.hostId.startsWith("offline_")) {
        room.hostId = socket.id;
        for (const p of room.players.values()) p.host = p.id === socket.id;
        player.ready = true;
      }

      socket.join(room.code);
      socket.data.roomCode = room.code;

      socket.emit("room:joined", {
        code: room.code,
        playerId: socket.id,
        isHost: room.hostId === socket.id
      });

      emitRoom(room);
      system(room, `${player.name} a rejoint le salon.`);
      await saveRoom(room);
    } catch (error) {
      console.error("Connexion au salon :", error);
      sendError(socket, "Impossible de rejoindre le salon.");
    }
  });

  socket.on("player:ready", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "lobby") return;

    player.ready = typeof data === "object" && data !== null
      ? !!data.ready
      : !!data;
    emitRoom(room);
  });

  socket.on("avatar:update", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player) return;

    if (!["lobby", "results", "finished"].includes(room.status)) {
      return sendError(
        socket,
        "Tu peux changer d'apparence uniquement entre les manches."
      );
    }

    const avatar = data?.avatar;
    if (!avatar || !MONSTER_IDS.includes(avatar.monsterId)) {
      return sendError(socket, "Monstre invalide.");
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(avatar.color || "")) {
      return sendError(socket, "Couleur invalide.");
    }
    if (!ACCESSORIES.includes(avatar.accessory)) {
      return sendError(socket, "Accessoire invalide.");
    }

    player.avatar = safeAvatar(avatar, ACCESSORIES);
    emitRoom(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.hostId !== socket.id) {
      return sendError(socket, "Seul l'hôte peut lancer la partie.");
    }
    if (room.status !== "lobby") return;

    purgeOfflinePlayers(room);

    if (room.players.size < 2) {
      emitRoom(room);
      return sendError(socket, "Il faut au moins deux joueurs.");
    }

    room.round = 1;
    room.lastResults = [];

    for (const p of room.players.values()) {
      p.score = 0;
      p.ready = true;
      p.submitted = false;
      p.activePowers = [];
    }

    startCountdown(room);
  });

  socket.on("roulette:stop-request", (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "roulette") return;
    if (!room.pendingTheme) return;
    if (room.spinnerId !== player.id) {
      return sendError(socket, "C'est au joueur désigné d'arrêter la roulette.");
    }
    if (throttled(socket, "roulette", 300)) return;

    const spinId = Number(data?.spinId);
    acceptPendingTheme(room, false, Number.isFinite(spinId) ? spinId : undefined);
  });

  socket.on("roulette:stop", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "roulette") return;
    if (!room.pendingTheme || room.spinnerId !== player.id) return;

    acceptPendingTheme(room, false);
  });

  socket.on("answers:submit", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "playing" || player.submitted) return;

    const submitted = data?.answers || data || {};
    const safe = {};

    for (const category of activeCategories(room)) {
      safe[category] = String(submitted[category] || "").trim().slice(0, 60);
    }

    room.submissions.set(player.id, safe);
    player.submitted = true;

    socket.emit("answers:accepted", { message: "Réponses reçues !" });

    if ([...room.players.values()].every(p => p.submitted)) {
      finishRound(room, false);
    } else {
      emitRoom(room);
    }
  });

  socket.on("answer:vote", data => submitVote(socket, data));

  socket.on("vote:next-player", (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "voting") return;
    if (room.hostId !== socket.id) {
      return sendError(socket, "Seul l'hôte peut passer au joueur suivant.");
    }

    const expected = Number.isInteger(data?.index) ? data.index : undefined;
    advanceVote(room, expected);
  });

  socket.on("round:next", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.hostId !== socket.id ||
        room.status !== "results") return;

    if (room.round >= room.maxRounds) {
      room.status = "finished";

      for (const p of room.players.values()) p.coins += FINISH_BONUS_COINS;

      emitRoom(room);
      io.to(room.code).emit("game:finished", roomState(room));
      return;
    }

    room.round++;
    startCountdown(room);
  });

  socket.on("shop:buy", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player) return;
    if (throttled(socket, "shop", 350)) return;

    const id = typeof data === "string"
      ? data
      : data?.itemId || data?.powerId;

    const cosmetic = typeof id === "string"
      ? COSMETICS.find(x => x.id === id)
      : null;
    const power = typeof id === "string"
      ? POWERS.find(x => x.id === id)
      : null;
    const item = cosmetic || power;

    if (!item) return sendError(socket, "Objet inconnu.");

    if (cosmetic) {
      if (player.cosmetics.includes(id)) {
        player.avatar = safeAvatar({ ...player.avatar, accessory: id }, ACCESSORIES);
        emitRoom(room);
        return socket.emit("shop:bought", {
          kind: "cosmetic",
          itemId: id,
          coins: player.coins,
          message: "Accessoire équipé !"
        });
      }

      if (player.coins < item.price) {
        return sendError(socket, "Pas assez de pièces.");
      }

      player.coins -= item.price;
      player.cosmetics.push(id);
      player.avatar = safeAvatar(
        { ...player.avatar, accessory: id },
        player.cosmetics
      );
    } else {
      if (!power.available) {
        return sendError(socket, "Ce pouvoir n'est pas encore disponible.");
      }
      if (player.coins < power.price) {
        return sendError(socket, "Pas assez de pièces.");
      }
      if (id === "double" && player.activePowers.includes("double")) {
        return sendError(socket, "Le multiplicateur est déjà actif.");
      }
      if (id === "shield" && player.shield) {
        return sendError(socket, "Ton bouclier est déjà actif.");
      }
      if (id !== "double" && id !== "shield" &&
          player.inventory.length >= MAX_INVENTORY) {
        return sendError(socket, "Inventaire plein.");
      }

      player.coins -= power.price;

      if (id === "double") {
        player.activePowers.push("double");
      } else if (id === "shield") {
        player.shield = true;
      } else {
        player.inventory.push(id);
      }
    }

    socket.emit("shop:bought", {
      kind: cosmetic ? "cosmetic" : "power",
      powerId: power ? id : undefined,
      itemId: id,
      coins: player.coins,
      message: "Achat effectué !"
    });

    emitRoom(room);
  });

  socket.on("power:use", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player) return;
    if (throttled(socket, "power", 300)) return;

    const id = typeof data?.powerId === "string" ? data.powerId : "";
    const target = room.players.get(String(data?.targetId || ""));

    if (!player.inventory.includes(id)) {
      return sendError(socket, "Tu ne possèdes pas ce pouvoir.");
    }

    if (id === "time") {
      if (room.status !== "playing") {
        return sendError(socket, "Utilise ce pouvoir pendant une manche.");
      }

      room.deadline += 10000;
      if (room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(
        () => finishRound(room, true),
        Math.max(0, room.deadline - Date.now())
      );
    } else if (id === "friend") {
      if (!target || target.id === player.id) {
        return sendError(socket, "Choisis un autre joueur.");
      }
      if (target.shield) {
        target.shield = false;
        player.inventory = player.inventory.filter(x => x !== id);
        emitRoom(room);
        return sendError(socket, "Le bouclier a bloqué le pouvoir.");
      }
      io.to(target.id).emit("power:friend-request", { from: player.name });
    } else if (id === "spy") {
      const others = [...room.players.values()].filter(p => p.id !== player.id);
      const enemy = randomItem(others);
      socket.emit("power:spy-result", {
        message: enemy
          ? `Catégorie : ${randomItem(activeCategories(room))}`
          : "Aucun adversaire."
      });
    } else if (id === "shield") {
      player.shield = true;
    } else if (id === "double") {
      player.activePowers.push("double");
    } else if (id === "mystery") {
      player.coins += 15;
    } else {
      return sendError(socket, "Ce pouvoir n'est pas disponible ici.");
    }

    player.inventory = player.inventory.filter(x => x !== id);
    emitRoom(room);
  });

  socket.on("chat:send", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);
    const message = String(typeof data === "string" ? data : data?.text || "")
      .trim()
      .slice(0, 180);

    if (!room || !player || !message) return;
    if (throttled(socket, "chat", 400)) return;

    io.to(room.code).emit("chat:message", {
      name: player.name,
      text: message,
      at: Date.now()
    });

    if (supabase) {
      void supabase.from("messages").insert({
        room_code: room.code,
        player_name: player.name,
        content: message
      }).then(({ error }) => {
        if (error) console.error("Message Supabase :", error.message);
      });
    }
  });

  socket.on("chat:private", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);
    const target = room?.players.get(String(data?.targetId || ""));
    const message = String(data?.text || "").trim().slice(0, 180);

    if (!player || !target || !message) return;
    if (throttled(socket, "private", 400)) return;

    if (target.shield) {
      target.shield = false;
      socket.emit("chat:private:notice", "Le bouclier a bloqué le message.");
      io.to(target.id).emit(
        "chat:private:notice",
        "Ton bouclier a bloqué un pouvoir."
      );
      emitRoom(room);
      return;
    }

    io.to(target.id).emit("chat:private", {
      from: player.name,
      text: message
    });

    socket.emit(
      "chat:private:notice",
      `Message envoyé à ${target.name}.`
    );
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

async function startServer() {
  await restoreRooms();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ALPHA BLITZ écoute sur le port ${PORT}`);
  });
}

startServer().catch(error => {
  console.error("Erreur de démarrage :", error);
  process.exit(1);
});
