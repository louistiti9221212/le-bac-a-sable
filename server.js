
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

const LETTERS = "ABCDEFGHJKLMNOPRSTV";

const MONSTER_IDS = [
  "blobito", "flamby", "cyclopi", "piquito", "touffu", "ombrix",
  "voltix", "goutti", "rococo", "fantomix", "zouzou", "arc-en-boum"
];

const ACCESSORIES = ["none", "crown", "glasses", "hat", "star"];

const POWERS = [
  { id: "friend", name: "📞 Appel à un ami", price: 30 },
  { id: "double", name: "✨ Multiplicateur", price: 55 },
  { id: "time", name: "⏱️ Temps bonus", price: 65 },
  { id: "spy", name: "🕵️ Espionnage", price: 70 },
  { id: "shield", name: "🛡️ Bouclier", price: 75 },
  { id: "change", name: "🔄 Changement de catégorie", price: 85 },
  { id: "mystery", name: "🎲 Pouvoir mystère", price: 100 }
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

function safeAvatar(input) {
  const avatar = input || {};
  return {
    monsterId: MONSTER_IDS.includes(avatar.monsterId)
      ? avatar.monsterId
      : "blobito",
    color: /^#[0-9a-fA-F]{6}$/.test(avatar.color || "")
      ? avatar.color
      : "#8b6cff",
    accessory: ACCESSORIES.includes(avatar.accessory)
      ? avatar.accessory
      : "none"
  };
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
    letter: room.status === "playing" ? room.letter : null,
    theme: room.theme,
    deadline: room.deadline,
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
      const { error } = await supabase
        .from("rooms")
        .upsert({
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
    .catch(error => {
      console.error("Erreur Supabase :", error.message);
    });

  saveQueues.set(room.code, current);
  return current;
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", roomState(room));
  void saveRoom(room);
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
  for (const key of ["timer", "countdownTimer", "rouletteTimer", "voteTimer"]) {
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
    lastResults: []
  };
}

function startCountdown(room) {
  stopTimers(room);
  room.status = "countdown";
  room.letter = null;
  room.theme = null;
  room.deadline = Date.now() + 3000;
  room.submissions = new Map();
  room.votes = new Map();

  for (const p of room.players.values()) {
    p.submitted = false;
  }

  emitRoom(room);
  io.to(room.code).emit("game:started", { round: room.round });
  system(room, "La partie commence dans 3 secondes !");

  room.countdownTimer = setTimeout(() => {
    if (room.status !== "countdown") return;
    startRoulette(room);
  }, 3000);
}

function startRoulette(room) {
  stopTimers(room);
  room.status = "roulette";
  room.theme = null;

  emitRoom(room);
  io.to(room.code).emit("roulette:start", {
    themes: [...room.categories]
  });

  system(room, "La roulette des thèmes est lancée !");

  // Si personne n'arrête la roue, le serveur choisit automatiquement.
  room.rouletteTimer = setTimeout(() => {
    if (room.status === "roulette") selectTheme(room);
  }, 12000);
}

function selectTheme(room) {
  if (room.status !== "roulette") return;

  if (room.rouletteTimer) clearTimeout(room.rouletteTimer);
  room.rouletteTimer = null;

  room.theme = randomItem(room.categories);
  room.letter = chooseLetter();
  room.status = "playing";
  room.deadline = Date.now() + room.duration * 1000;
  room.submissions = new Map();
  room.votes = new Map();

  for (const p of room.players.values()) p.submitted = false;

  io.to(room.code).emit("roulette:result", {
    theme: room.theme,
    letter: room.letter
  });

  // Cet événement démarre aussi le chronomètre du client.
  io.to(room.code).emit("game:round", {
    round: room.round,
    theme: room.theme,
    letter: room.letter,
    duration: room.duration,
    categories: room.categories
  });

  system(room, `Thème : ${room.theme}. Lettre : ${room.letter} !`);
  room.timer = setTimeout(() => finishRound(room, true), room.duration * 1000);

  emitRoom(room);
}

function publicVotePlayer(room, player) {
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    answers: room.submissions.get(player.id) || {}
  };
}

function startVoting(room) {
  stopTimers(room);
  room.status = "voting";
  room.votes = new Map();

  room.votePlayers = [...room.players.values()].map(p => p.id);
  room.voteIndex = 0;

  const players = room.votePlayers.map(id =>
    publicVotePlayer(room, room.players.get(id))
  );

  io.to(room.code).emit("vote:start", { players });
  emitRoom(room);
  system(room, "La phase de vote commence !");

  room.voteTimer = setTimeout(() => finishVoting(room), 60000);
}

function finishRound(room, timedOut = false) {
  if (room.status !== "playing") return;

  stopTimers(room);

  // Les joueurs qui n'ont pas soumis de réponses reçoivent une grille vide.
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

  for (const player of room.players.values()) {
    const answers = room.submissions.get(player.id) || {};
    const rows = [];
    let valid = 0;
    let earned = 0;

    for (const category of room.categories) {
      const word = String(answers[category] || "").trim().slice(0, 60);
      const ballot = room.votes.get(`${player.id}:${category}`) || new Map();

      const yes = [...ballot.values()].filter(v => v === "accept").length;
      const no = [...ballot.values()].filter(v => v === "reject").length;

      // Majorité stricte : égalité ou aucun vote = refus.
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

    results.push({
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      valid,
      earned,
      rows
    });
  }

  room.lastResults = results;
  room.status = "results";

  io.to(room.code).emit("round:results", {
    round: room.round,
    letter: room.letter,
    theme: room.theme,
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

  if (!room.categories.includes(category)) {
    return sendError(socket, "Catégorie invalide.");
  }

  const word = String((room.submissions.get(targetId) || {})[category] || "").trim();
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

  void saveRoom(room);
}

function leaveRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  const player = room.players.get(socket.id);
  room.players.delete(socket.id);

  if (player && supabase) {
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
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === socket.id) {
    const next = room.players.values().next().value;
    room.hostId = next.id;

    for (const p of room.players.values()) p.host = p.id === next.id;
  }

  emitRoom(room);
  system(room, "Un joueur a quitté la salle.");
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
      if (!saved?.code || !Array.isArray(saved.players) || !saved.players.length) continue;

      // Les anciens sockets ne sont plus valides après un redémarrage.
      // On restaure le salon sans prétendre restaurer les connexions.
      const players = new Map();
      let firstId = null;

      for (const old of saved.players) {
        const id = `offline_${crypto.randomUUID()}`;
        if (!firstId) firstId = id;

        players.set(id, {
          id,
          name: cleanName(old.name),
          score: Number(old.score) || 0,
          coins: Number(old.coins) || 0,
          ready: false,
          host: false,
          avatar: safeAvatar(old.avatar),
          inventory: Array.isArray(old.inventory) ? old.inventory : [],
          activePowers: Array.isArray(old.activePowers) ? old.activePowers : [],
          shield: !!old.shield,
          submitted: false
        });
      }

      const room = {
        code: saved.code,
        hostId: firstId,
        players,
        status: saved.status,
        round: Number(saved.round) || 1,
        maxRounds: Number(saved.maxRounds) || 5,
        duration: Number(saved.duration) || 60,
        categories: Array.isArray(saved.categories) ? saved.categories : [...CATEGORIES],
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

io.on("connection", socket => {
  socket.emit("game:config", {
    categories: CATEGORIES,
    powers: POWERS
  });

  socket.on("room:create", async (data = {}) => {
    try {
      leaveRoom(socket);

      let roomCode;
      do {
        roomCode = makeCode();
      } while (rooms.has(roomCode));

      const player = {
        id: socket.id,
        name: cleanName(data.name),
        score: 0,
        coins: 50,
        ready: true,
        host: true,
        avatar: safeAvatar(data.avatar),
        inventory: [],
        activePowers: [],
        shield: false,
        submitted: false
      };

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

  socket.on("room:join", async data => {
    leaveRoom(socket);

    const roomCode = String(data?.code || "").trim().toUpperCase();
    const room = rooms.get(roomCode);

    if (!room) return sendError(socket, "Salon introuvable.");
    if (!["lobby", "results", "finished"].includes(room.status)) {
      return sendError(socket, "La partie est en cours.");
    }
    if (room.players.size >= 8) return sendError(socket, "Le salon est complet.");

    const player = {
      id: socket.id,
      name: cleanName(data.name),
      score: 0,
      coins: 50,
      ready: false,
      host: false,
      avatar: safeAvatar(data.avatar),
      inventory: [],
      activePowers: [],
      shield: false,
      submitted: false
    };

    room.players.set(socket.id, player);

    if (!room.players.has(room.hostId) || room.hostId.startsWith("offline_")) {
      room.hostId = socket.id;
      for (const p of room.players.values()) p.host = p.id === socket.id;
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
  });

  socket.on("player:ready", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "lobby") return;

    player.ready = typeof data === "object" ? !!data.ready : !!data;
    emitRoom(room);
  });

  socket.on("avatar:update", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || !["lobby", "results", "finished"].includes(room.status)) return;

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

    player.avatar = safeAvatar(avatar);
    emitRoom(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.hostId !== socket.id) {
      return sendError(socket, "Seul l'hôte peut lancer la partie.");
    }
    if (room.status !== "lobby") return;
    if (room.players.size < 2) {
      return sendError(socket, "Il faut au moins deux joueurs.");
    }

    room.round = 1;

    for (const p of room.players.values()) {
      p.score = 0;
      p.ready = true;
      p.submitted = false;
      p.activePowers = [];
    }

    startCountdown(room);
  });

  // Le serveur choisit lui-même le thème. Le client ne peut pas imposer son résultat.
  socket.on("roulette:stop-request", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "roulette") return;
    selectTheme(room);
  });

  // Compatibilité : ne jamais faire confiance au thème choisi dans le navigateur.
  socket.on("roulette:stop", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room?.status === "roulette") selectTheme(room);
  });

  socket.on("answers:submit", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.status !== "playing" || player.submitted) return;

    const submitted = data?.answers || data || {};
    const safe = {};

    for (const category of room.categories) {
      safe[category] = String(submitted[category] || "").trim().slice(0, 60);
    }

    room.submissions.set(player.id, safe);
    player.submitted = true;

    socket.emit("answers:accepted", {
      message: "Réponses reçues !"
    });

    if ([...room.players.values()].every(p => p.submitted)) {
      finishRound(room, false);
    } else {
      emitRoom(room);
    }
  });

  socket.on("answer:vote", data => submitVote(socket, data));

  socket.on("vote:next-player", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "voting") return;

    // Tous les clients reçoivent la même progression.
    room.voteIndex++;

    if (room.voteIndex >= room.votePlayers.length) {
      finishVoting(room);
      return;
    }

    const target = room.players.get(room.votePlayers[room.voteIndex]);
    if (!target) return;

    io.to(room.code).emit("vote:player", {
      player: publicVotePlayer(room, target),
      index: room.voteIndex,
      total: room.votePlayers.length
    });
  });

  socket.on("round:next", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);

    if (!room || !player || room.hostId !== socket.id || room.status !== "results") return;

    if (room.round >= room.maxRounds) {
      room.status = "finished";
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

    const id = typeof data === "string" ? data : data?.powerId || data?.itemId;
    const power = POWERS.find(x => x.id === id);

    if (!power) return sendError(socket, "Objet inconnu.");
    if (player.coins < power.price) return sendError(socket, "Pas assez de pièces.");
    if (player.inventory.length >= 2) return sendError(socket, "Inventaire plein.");

    player.coins -= power.price;

    if (id === "double") {
      player.activePowers.push("double");
    } else if (id === "shield") {
      player.shield = true;
    } else {
      player.inventory.push(id);
    }

    socket.emit("shop:bought", {
      powerId: id,
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

    const id = data?.powerId;
    const target = room.players.get(data?.targetId);

    if (!player.inventory.includes(id)) {
      return sendError(socket, "Tu ne possèdes pas ce pouvoir.");
    }

    if (id === "time") {
      if (room.status !== "playing") return sendError(socket, "Utilise ce pouvoir pendant une manche.");
      room.deadline += 10000;
      if (room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(
        () => finishRound(room, true),
        Math.max(0, room.deadline - Date.now())
      );
    } else if (id === "friend") {
      if (!target || target.id === player.id) return sendError(socket, "Choisis un autre joueur.");
      if (target.shield) {
        target.shield = false;
        emitRoom(room);
        return sendError(socket, "Le bouclier a bloqué le pouvoir.");
      }
      io.to(target.id).emit("power:friend-request", { from: player.name });
    } else if (id === "spy") {
      const others = [...room.players.values()].filter(p => p.id !== player.id);
      const enemy = randomItem(others);
      socket.emit("power:spy-result", {
        message: enemy
          ? `Catégorie : ${randomItem(room.categories)}`
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
      });
    }
  });

  socket.on("chat:private", data => {
    const room = rooms.get(socket.data.roomCode);
    const player = playerForSocket(room, socket);
    const target = room?.players.get(data?.targetId);
    const message = String(data?.text || "").trim().slice(0, 180);

    if (!player || !target || !message) return;

    if (target.shield) {
      target.shield = false;
      socket.emit("chat:private:notice", "Le bouclier a bloqué le message.");
      io.to(target.id).emit("chat:private:notice", "Ton bouclier a bloqué un pouvoir.");
      emitRoom(room);
      return;
    }

    io.to(target.id).emit("chat:private", { from: player.name, text: message });
    socket.emit("chat:private:notice", `Message envoyé à ${target.name}.`);
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
