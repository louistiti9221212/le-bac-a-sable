
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "Le Bac à Sable" })
);

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      )
    : null;

if (!supabase) {
  console.warn("Supabase non configuré : sauvegarde désactivée.");
}

const CATEGORIES = [
  "Prénom", "Ville ou pays", "Animal", "Métier",
  "Objet", "Aliment", "Célébrité", "Marque"
];
const LETTERS = "ABCDEFGHJKLMNOPRSTV";
const POWERS = [
  { id: "friend", name: "📞 Appel à un ami", price: 30, description: "Envoie une demande d'indice privé à un joueur." },
  { id: "double", name: "✨ Multiplicateur", price: 55, description: "Double les pièces gagnées sur cette manche." },
  { id: "time", name: "⏱️ Temps bonus", price: 65, description: "Ajoute 10 secondes à la manche." },
  { id: "spy", name: "🕵️ Espionnage", price: 70, description: "Découvre une catégorie chez un adversaire." },
  { id: "shield", name: "🛡️ Bouclier", price: 75, description: "Protège contre le prochain pouvoir ciblé." },
  { id: "change", name: "🔄 Changement de catégorie", price: 85, description: "Remplace une catégorie par une catégorie aléatoire." },
  { id: "mystery", name: "🎲 Pouvoir mystère", price: 100, description: "Un effet aléatoire." }
];

const rooms = new Map();
const saveQueues = new Map();

const norm = s =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
const cleanName = s =>
  String(s || "Joueur").replace(/[<>]/g, "").trim().slice(0, 18) || "Joueur";
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const publicPlayer = p => ({
  id: p.id,
  name: p.name,
  score: p.score,
  ready: p.ready,
  host: p.host,
  inventory: p.inventory
});

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
    deadline: room.deadline,
    lastResults: room.lastResults || [],
    submissions: [...room.submissions.entries()],
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      coins: p.coins,
      ready: p.ready,
      host: p.host,
      inventory: p.inventory || [],
      activePowers: p.activePowers || [],
      shield: !!p.shield,
      submitted: !!p.submitted
    }))
  };
}

// Les sauvegardes d'un même salon sont exécutées dans l'ordre.
function saveRoom(room) {
  if (!supabase || !room) return Promise.resolve();

  const snapshot = serializeRoom(room);
  const roomCode = room.code;

  const previous = saveQueues.get(roomCode) || Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(async () => {
      const { error } = await supabase
        .from("rooms")
        .upsert({
          code: roomCode,
          host_id: snapshot.hostId,
          status: snapshot.status,
          duration: snapshot.duration,
          round: snapshot.round,
          game: snapshot,
          updated_at: new Date().toISOString()
        }, { onConflict: "code" });

      if (error) throw error;

      // Synchronise la table players avec l'état sauvegardé.
      const { error: deleteError } = await supabase
        .from("players")
        .delete()
        .eq("room_code", roomCode);

      if (deleteError) throw deleteError;

      if (snapshot.players.length) {
        const { error: insertError } = await supabase
          .from("players")
          .insert(snapshot.players.map(p => ({
            room_code: roomCode,
            player_id: p.id,
            player_name: p.name,
            score: p.score,
            connected: true
          })));

        if (insertError) throw insertError;
      }
    })
    .catch(error => {
      console.error("Sauvegarde Supabase :", error.message);
    });

  saveQueues.set(roomCode, current);
  return current;
}

async function saveMessage(roomCode, playerName, content) {
  if (!supabase) return;

  try {
    const { error } = await supabase.from("messages").insert({
      room_code: roomCode,
      player_name: playerName,
      content: String(content || "").slice(0, 180)
    });
    if (error) throw error;
  } catch (error) {
    console.error("Sauvegarde message :", error.message);
  }
}

function roomState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: [...room.players.values()].map(publicPlayer),
    round: room.round,
    maxRounds: room.maxRounds,
    duration: room.duration,
    letter: room.status === "playing" ? room.letter : null,
    deadline: room.deadline,
    categories: room.categories,
    powers: POWERS,
    leaderboard: [...room.players.values()]
      .map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        coins: p.coins
      }))
      .sort((a, b) => b.score - a.score)
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", roomState(room));
  void saveRoom(room);
}

function system(room, message) {
  const item = {
    name: "Le jeu",
    text: message,
    system: true,
    at: Date.now()
  };
  io.to(room.code).emit("chat:message", item);
  void saveMessage(room.code, "Le jeu", message);
}

function sendError(socket, message) {
  socket.emit("app:error", message);
}

function findPlayer(room, socket) {
  return room?.players.get(socket.id);
}

function stopTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.timer = null;
  room.countdownTimer = null;
}

function chooseLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function startCountdown(room) {
  stopTimer(room);
  room.status = "countdown";
  room.letter = null;
  room.deadline = Date.now() + 4000;
  emitRoom(room);
  system(room, `Préparez-vous : manche ${room.round} dans 3 secondes !`);
  room.countdownTimer = setTimeout(() => startRound(room), 4000);
}

function startRound(room) {
  stopTimer(room);
  room.status = "playing";
  room.letter = chooseLetter();
  room.deadline = Date.now() + room.duration * 1000;
  room.submissions = new Map();

  for (const p of room.players.values()) p.submitted = false;

  room.timer = setTimeout(() => finishRound(room, true), room.duration * 1000);
  emitRoom(room);
  system(room, `Manche ${room.round} : la lettre est ${room.letter} !`);
}

function finishRound(room, timedOut = false) {
  if (room.status !== "playing") return;

  stopTimer(room);
  room.status = "results";
  const details = [];

  for (const p of room.players.values()) {
    const answers = room.submissions.get(p.id) || {};
    const rows = [];
    let valid = 0;
    let earned = 0;

    for (const cat of room.categories) {
      const word = String(answers[cat] || "").trim().slice(0, 60);
      const ok = !!word && norm(word).startsWith(room.letter);

      if (ok) {
        valid++;
        p.score += 10;

        let reward = word.length >= 9 ? 12 : word.length >= 6 ? 8 : 5;
        if (p.activePowers.includes("double")) {
          reward = Math.min(25, reward * 2);
        }

        p.coins += reward;
        earned += reward;
        rows.push({ category: cat, word, valid: true, points: 10, coins: reward });
      } else {
        rows.push({ category: cat, word, valid: false, points: 0, coins: 0 });
      }
    }

    p.activePowers = p.activePowers.filter(x => x !== "double");
    details.push({
      playerId: p.id,
      name: p.name,
      score: p.score,
      valid,
      earned,
      rows
    });
  }

  room.lastResults = details;
  io.to(room.code).emit("round:results", {
    round: room.round,
    letter: room.letter,
    timedOut,
    results: details,
    state: roomState(room)
  });
  emitRoom(room);
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
        if (error) console.error("Déconnexion joueur :", error.message);
      });
  }

  if (!room.players.size) {
    stopTimer(room);
    rooms.delete(roomCode);

    if (supabase) {
      // Le salon est conservé en base pour permettre une reprise ultérieure.
      void saveRoom(room);
    }
    return;
  }

  if (room.hostId === socket.id) {
    const next = room.players.values().next().value;
    room.hostId = next.id;
    next.host = true;
  }

  emitRoom(room);
  system(room, "Un joueur a quitté la salle.");
}

// Restaure les salons sauvegardés avant d'accepter les connexions.
async function restoreRooms() {
  if (!supabase) return;

  try {
    const { data, error } = await supabase
      .from("rooms")
      .select("code, game")
      .in("status", ["lobby", "countdown", "playing", "results", "finished"]);

    if (error) throw error;

    for (const row of data || []) {
      const saved = row.game;
      if (!saved || !saved.code || !Array.isArray(saved.players)) continue;

      // Les salons vides ou incomplets ne sont pas restaurés.
      const players = new Map();

      for (const p of saved.players) {
        const id = `offline_${crypto.randomUUID()}`;
        players.set(id, {
          id,
          name: cleanName(p.name),
          score: Number(p.score) || 0,
          coins: Number(p.coins) || 0,
          ready: !!p.ready,
          host: false,
          inventory: Array.isArray(p.inventory) ? p.inventory : [],
          activePowers: Array.isArray(p.activePowers) ? p.activePowers : [],
          shield: !!p.shield,
          submitted: !!p.submitted
        });
      }

      if (!players.size) continue;

      const host = players.values().next().value;
      host.host = true;

      // Un compte Socket.IO n'existe plus après un redémarrage.
      // Les joueurs devront rejoindre à nouveau le salon.
      const room = {
        code: saved.code,
        hostId: host.id,
        players,
        status: saved.status === "playing" || saved.status === "countdown"
          ? "results"
          : saved.status,
        round: Number(saved.round) || 1,
        maxRounds: Number(saved.maxRounds) || 5,
        duration: Number(saved.duration) || 180,
        categories: Array.isArray(saved.categories) ? saved.categories : [...CATEGORIES],
        letter: saved.letter || null,
        deadline: null,
        submissions: new Map(Array.isArray(saved.submissions) ? saved.submissions : []),
        timer: null,
        countdownTimer: null,
        lastResults: Array.isArray(saved.lastResults) ? saved.lastResults : []
      };

      rooms.set(room.code, room);
      console.log(`Salon restauré : ${room.code}`);
    }

    console.log(`${rooms.size} salon(s) restauré(s) depuis Supabase.`);
  } catch (error) {
    console.error("Restauration Supabase :", error.message);
  }
}

io.on("connection", socket => {
  socket.emit("game:config", { categories: CATEGORIES, powers: POWERS });

  socket.on("room:create", async ({ name, maxRounds, duration } = {}) => {
    try {
      leaveRoom(socket);

      let roomCode;
      do {
        roomCode = code();
      } while (rooms.has(roomCode));

      const player = {
        id: socket.id,
        name: cleanName(name),
        score: 0,
        coins: 50,
        ready: true,
        host: true,
        inventory: [],
        activePowers: [],
        shield: false,
        submitted: false
      };

      const room = {
        code: roomCode,
        hostId: socket.id,
        players: new Map([[socket.id, player]]),
        status: "lobby",
        round: 1,
        maxRounds: Math.max(1, Math.min(10, Number(maxRounds) || 5)),
        duration: Math.max(30, Math.min(180, Number(duration) || 180)),
        categories: [...CATEGORIES],
        letter: null,
        deadline: null,
        submissions: new Map(),
        timer: null,
        countdownTimer: null,
        lastResults: []
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      socket.emit("room:joined", { code: roomCode, playerId: socket.id });
      emitRoom(room);
      system(room, `${player.name} a créé la salle.`);
      await saveRoom(room);
    } catch (error) {
      console.error("Erreur création salle :", error);
      sendError(socket, "Le serveur n'a pas réussi à créer la salle. Consulte les journaux Render.");
    }
  });

  socket.on("room:join", async ({ name, code: inputCode } = {}) => {
    leaveRoom(socket);

    const room = rooms.get(String(inputCode || "").trim().toUpperCase());
    if (!room) return sendError(socket, "Cette salle n'existe pas. Vérifie le code.");
    if (!["lobby", "results", "finished"].includes(room.status)) {
      return sendError(socket, "La partie est en cours. Réessaie après la manche.");
    }
    if (room.players.size >= 8) return sendError(socket, "La salle est complète (8 joueurs maximum).");

    const player = {
      id: socket.id,
      name: cleanName(name),
      score: 0,
      coins: 50,
      ready: false,
      host: false,
      inventory: [],
      activePowers: [],
      shield: false,
      submitted: false
    };

    room.players.set(socket.id, player);

    // Si l'hôte restauré n'a plus de connexion, le nouveau joueur devient hôte.
    if (!room.players.has(room.hostId) || String(room.hostId).startsWith("offline_")) {
      for (const pl of room.players.values()) pl.host = false;
      room.hostId = socket.id;
      player.host = true;
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit("room:joined", { code: room.code, playerId: socket.id });

    emitRoom(room);
    system(room, `${player.name} a rejoint la salle.`);
    await saveRoom(room);
  });

  socket.on("player:ready", ready => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);
    if (!p || room.status !== "lobby") return;

    p.ready = !!ready;
    emitRoom(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);

    if (!room || !p || room.hostId !== socket.id) {
      return sendError(socket, "Seul l'hôte peut lancer la partie.");
    }
    if (room.players.size < 2) {
      return sendError(socket, "Il faut au moins 2 joueurs pour lancer la partie.");
    }
    if (room.status !== "lobby") return;

    room.round = 1;
    for (const pl of room.players.values()) {
      pl.score = 0;
      pl.ready = true;
      pl.inventory = [];
      pl.activePowers = [];
    }
    startCountdown(room);
  });

  socket.on("answers:submit", answers => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);
    if (!room || !p || room.status !== "playing" || p.submitted) return;

    const safe = {};
    for (const cat of room.categories) {
      safe[cat] = String(answers?.[cat] || "").trim().slice(0, 60);
    }

    room.submissions.set(p.id, safe);
    p.submitted = true;
    socket.emit("answers:accepted", { message: "Tes réponses ont été envoyées." });

    if ([...room.players.values()].every(pl => pl.submitted)) {
      finishRound(room, false);
    } else {
      emitRoom(room);
    }
  });

  socket.on("chat:send", raw => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);
    const text = String(raw || "").trim().slice(0, 180);
    if (!room || !p || !text) return;

    io.to(room.code).emit("chat:message", {
      name: p.name,
      text,
      at: Date.now()
    });
    void saveMessage(room.code, p.name, text);
  });

  socket.on("chat:private", ({ targetId, text } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);
    const target = room?.players.get(targetId);
    const message = String(text || "").trim().slice(0, 180);

    if (!p || !target || !message) return;

    if (target.shield) {
      target.shield = false;
      socket.emit("chat:private:notice", "Le bouclier de ce joueur a bloqué ton pouvoir.");
      io.to(target.id).emit("chat:private:notice", "Ton bouclier a bloqué un pouvoir.");
      emitRoom(room);
      return;
    }

    io.to(target.id).emit("chat:private", { from: p.name, text: message });
    socket.emit("chat:private:notice", `Message privé envoyé à ${target.name}.`);
  });

  socket.on("shop:buy", powerId => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);
    const power = POWERS.find(x => x.id === powerId);
    if (!room || !p || !power) return;

    if (room.status === "playing" && p.submitted) {
      return sendError(socket, "Tu as déjà envoyé tes réponses.");
    }
    if (p.inventory.length >= 2) {
      return sendError(socket, "Ton inventaire est plein (2 pouvoirs maximum).");
    }
    if (p.coins < power.price) return sendError(socket, "Tu n'as pas assez de pièces.");

    p.coins -= power.price;

    if (powerId === "time") {
      if (room.status !== "playing") {
        p.inventory.push(powerId);
      } else {
        room.deadline += 10000;
        if (room.timer) {
          clearTimeout(room.timer);
          room.timer = setTimeout(
            () => finishRound(room, true),
            Math.max(0, room.deadline - Date.now())
          );
        }
      }
    } else if (powerId === "double") {
      p.activePowers.push("double");
    } else if (powerId === "shield") {
      p.shield = true;
      p.inventory.push(powerId);
    } else if (powerId === "mystery") {
      const roll = Math.floor(Math.random() * 3);
      if (roll === 0) p.coins += 15;
      else if (roll === 1) {
        if (room.status === "playing") room.deadline += 10000;
        else p.inventory.push("time");
      }
    } else {
      p.inventory.push(powerId);
    }

    socket.emit("shop:bought", { powerId, message: "Achat effectué !" });
    emitRoom(room);
  });

  socket.on("power:use", ({ powerId, targetId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);

    if (!room || !p || !p.inventory.includes(powerId)) {
      return sendError(socket, "Tu ne possèdes pas ce pouvoir.");
    }
    if (room.status === "playing" && p.submitted) {
      return sendError(socket, "Tu as déjà envoyé tes réponses.");
    }

    if (powerId === "friend") {
      const target = room.players.get(targetId);
      if (!target || target.id === p.id) {
        return sendError(socket, "Choisis un autre joueur.");
      }
      if (target.shield) {
        target.shield = false;
        emitRoom(room);
        return sendError(socket, "Le bouclier a bloqué le pouvoir.");
      }
      io.to(target.id).emit("power:friend-request", { from: p.name });
      socket.emit("chat:private:notice", "Demande d'aide envoyée.");
    } else if (powerId === "spy") {
      const target = [...room.players.values()].find(x => x.id !== p.id);
      socket.emit("power:spy-result", {
        message: target
          ? `Catégorie révélée chez ${target.name} : ${room.categories[Math.floor(Math.random() * room.categories.length)]}`
          : "Aucun adversaire."
      });
    } else if (powerId === "change") {
      if (room.status !== "lobby") {
        return sendError(socket, "Ce pouvoir est utilisable avant le début de la partie.");
      }
      const idx = Math.floor(Math.random() * room.categories.length);
      const replacement = ["Film", "Sport", "Personnage fictif", "Vêtement", "Instrument", "Plante"][
        Math.floor(Math.random() * 6)
      ];
      room.categories[idx] = replacement;
      system(room, `${p.name} a changé une catégorie !`);
    } else if (powerId === "time") {
      if (room.status !== "playing") {
        return sendError(socket, "Le temps bonus s'utilise pendant une manche.");
      }
      room.deadline += 10000;
      if (room.timer) {
        clearTimeout(room.timer);
        room.timer = setTimeout(
          () => finishRound(room, true),
          Math.max(0, room.deadline - Date.now())
        );
      }
    } else if (powerId === "shield") {
      p.shield = true;
    } else if (powerId === "double") {
      p.activePowers.push("double");
    } else if (powerId === "mystery") {
      p.coins += 15;
    }

    p.inventory = p.inventory.filter(x => x !== powerId);
    emitRoom(room);
  });

  socket.on("round:next", () => {
    const room = rooms.get(socket.data.roomCode);
    const p = findPlayer(room, socket);

    if (!room || !p || room.hostId !== socket.id || room.status !== "results") return;

    if (room.round >= room.maxRounds) {
      room.status = "finished";
      emitRoom(room);
      io.to(room.code).emit("game:finished", roomState(room));
      return;
    }

    room.round++;
    startCountdown(room);
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

async function startServer() {
  await restoreRooms();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Le Bac à Sable écoute sur le port ${PORT}`);
  });
}

startServer();
