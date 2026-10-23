const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, service: "Le Bac à Sable" }));

const CATEGORIES = ["Prénom", "Ville ou pays", "Animal", "Métier", "Objet", "Aliment", "Célébrité", "Marque"];
const LETTERS = "ABCDEFGHJKLMNOPRSTV";
const POWERS = [
  { id: "friend", name: "📞 Appel à un ami", price: 30, description: "Envoie une demande d'indice privé à un joueur." },
  { id: "double", name: "✨ Multiplicateur", price: 55, description: "Double les pièces gagnées sur cette manche (bonus limité)." },
  { id: "time", name: "⏱️ Temps bonus", price: 65, description: "Ajoute 10 secondes à la manche." },
  { id: "spy", name: "🕵️ Espionnage", price: 70, description: "Découvre une catégorie choisie au hasard chez un adversaire." },
  { id: "shield", name: "🛡️ Bouclier", price: 75, description: "Protège contre la prochaine demande de pouvoir ciblée." },
  { id: "change", name: "🔄 Changement de catégorie", price: 85, description: "Dans cette démo, remplace une catégorie par une catégorie aléatoire." },
  { id: "mystery", name: "🎲 Pouvoir mystère", price: 100, description: "Un effet aléatoire." }
];
const rooms = new Map();
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
const cleanName = s => String(s || "Joueur").replace(/[<>]/g, "").trim().slice(0, 18) || "Joueur";
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const publicPlayer = p => ({ id: p.id, name: p.name, score: p.score, ready: p.ready, host: p.host, inventory: p.inventory });

function roomState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId,
    players: [...room.players.values()].map(publicPlayer),
    round: room.round, maxRounds: room.maxRounds, duration: room.duration,
    letter: room.status === "playing" ? room.letter : null,
    deadline: room.deadline, categories: room.categories,
    powers: POWERS,
    leaderboard: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, coins: p.coins })).sort((a,b) => b.score-a.score)
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", roomState(room)); }
function system(room, message) { io.to(room.code).emit("chat:message", { name: "Le jeu", text: message, system: true, at: Date.now() }); }
function sendError(socket, message) { socket.emit("app:error", message); }
function findPlayer(room, socket) { return room?.players.get(socket.id); }
function stopTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function chooseLetter() { return LETTERS[Math.floor(Math.random() * LETTERS.length)]; }
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
    let valid = 0, earned = 0;
    for (const cat of room.categories) {
      const word = String(answers[cat] || "").trim().slice(0, 60);
      const ok = !!word && norm(word).startsWith(room.letter);
      if (ok) {
        valid++;
        p.score += 10;
        let reward = word.length >= 9 ? 12 : word.length >= 6 ? 8 : 5;
        if (p.activePowers.includes("double")) reward = Math.min(25, reward * 2);
        p.coins += reward; earned += reward;
        rows.push({ category: cat, word, valid: true, points: 10, coins: reward });
      } else if (word) rows.push({ category: cat, word, valid: false, points: 0, coins: 0 });
      else rows.push({ category: cat, word: "", valid: false, points: 0, coins: 0 });
    }
    p.activePowers = p.activePowers.filter(x => x !== "double");
    details.push({ playerId: p.id, name: p.name, score: p.score, valid, earned, rows });
  }
  room.lastResults = details;
  io.to(room.code).emit("round:results", { round: room.round, letter: room.letter, timedOut, results: details, state: roomState(room) });
  emitRoom(room);
}
function leaveRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  if (!room.players.size) {
    stopTimer(room);
    rooms.delete(roomCode);
    return;
  }
  if (room.hostId === socket.id) {
    const next = room.players.values().next().value;
    room.hostId = next.id; next.host = true;
  }
  emitRoom(room);
  system(room, "Un joueur a quitté la salle.");
}
io.on("connection", socket => {
  socket.emit("game:config", { categories: CATEGORIES, powers: POWERS });
  socket.on("room:create", ({ name, maxRounds, duration } = {}) => {
    leaveRoom(socket);
    let roomCode;
    do { roomCode = code(); } while (rooms.has(roomCode));
    const player = { id: socket.id, name: cleanName(name), score: 0, coins: 50, ready: true, host: true, inventory: [], activePowers: [], shield: false, submitted: false };
    const room = {
      code: roomCode, hostId: socket.id, players: new Map([[socket.id, player]]), status: "lobby",
      round: 1, maxRounds: Math.max(1, Math.min(10, Number(maxRounds) || 5)),
      duration: Math.max(30, Math.min(180, Number(duration) || 90)),
      categories: [...CATEGORIES], letter: null, deadline: null, submissions: new Map(), timer: null, lastResults: []
    };
    rooms.set(roomCode, room); socket.join(roomCode); socket.data.roomCode = roomCode;
    socket.emit("room:joined", { code: roomCode, playerId: socket.id });
    emitRoom(room); system(room, `${player.name} a créé la salle.`);
  });
  socket.on("room:join", ({ name, code: inputCode } = {}) => {
    leaveRoom(socket);
    const room = rooms.get(String(inputCode || "").trim().toUpperCase());
    if (!room) return sendError(socket, "Cette salle n'existe pas. Vérifie le code.");
    if (room.status !== "lobby") return sendError(socket, "La partie a déjà commencé.");
    if (room.players.size >= 8) return sendError(socket, "La salle est complète (8 joueurs maximum).");
    const player = { id: socket.id, name: cleanName(name), score: 0, coins: 50, ready: false, host: false, inventory: [], activePowers: [], shield: false, submitted: false };
    room.players.set(socket.id, player); socket.join(room.code); socket.data.roomCode = room.code;
    socket.emit("room:joined", { code: room.code, playerId: socket.id });
    emitRoom(room); system(room, `${player.name} a rejoint la salle.`);
  });
  socket.on("player:ready", ready => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    if (!p || room.status !== "lobby") return;
    p.ready = !!ready; emitRoom(room);
  });
  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    if (!room || !p || room.hostId !== socket.id) return sendError(socket, "Seul l'hôte peut lancer la partie.");
    if (room.players.size < 2) return sendError(socket, "Il faut au moins 2 joueurs pour lancer la partie.");
    if (room.status !== "lobby") return;
    room.round = 1;
    for (const pl of room.players.values()) { pl.score = 0; pl.ready = true; pl.inventory = []; pl.activePowers = []; }
    startRound(room);
  });
  socket.on("answers:submit", answers => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    if (!room || !p || room.status !== "playing" || p.submitted) return;
    const safe = {};
    for (const cat of room.categories) safe[cat] = String(answers?.[cat] || "").trim().slice(0, 60);
    room.submissions.set(p.id, safe); p.submitted = true;
    socket.emit("answers:accepted", { message: "Tes réponses ont été envoyées." });
    if ([...room.players.values()].every(pl => pl.submitted)) finishRound(room, false);
    else emitRoom(room);
  });
  socket.on("chat:send", raw => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    const text = String(raw || "").trim().slice(0, 180);
    if (!room || !p || !text) return;
    io.to(room.code).emit("chat:message", { name: p.name, text, at: Date.now() });
  });
  socket.on("chat:private", ({ targetId, text } = {}) => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    const target = room?.players.get(targetId);
    const message = String(text || "").trim().slice(0, 180);
    if (!p || !target || !message) return;
    if (target.shield) { target.shield = false; socket.emit("chat:private:notice", "Le bouclier de ce joueur a bloqué ton pouvoir."); target.id && io.to(target.id).emit("chat:private:notice", "Ton bouclier a bloqué un pouvoir."); return; }
    io.to(target.id).emit("chat:private", { from: p.name, text: message });
    socket.emit("chat:private:notice", `Message privé envoyé à ${target.name}.`);
  });
  socket.on("shop:buy", powerId => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    const power = POWERS.find(x => x.id === powerId);
    if (!room || !p || !power) return;
    if (room.status === "playing" && p.submitted) return sendError(socket, "Tu as déjà envoyé tes réponses.");
    if (p.inventory.length >= 2) return sendError(socket, "Ton inventaire est plein (2 pouvoirs maximum).");
    if (p.coins < power.price) return sendError(socket, "Tu n'as pas assez de pièces.");
    p.coins -= power.price;
    if (powerId === "time") {
      if (room.status !== "playing") { p.inventory.push(powerId); }
      else { room.deadline += 10000; }
    } else if (powerId === "double") {
      p.activePowers.push("double");
    } else if (powerId === "shield") {
      p.shield = true; p.inventory.push(powerId);
    } else if (powerId === "mystery") {
      const roll = Math.floor(Math.random() * 3);
      if (roll === 0) p.coins += 15;
      else if (roll === 1) { if (room.status === "playing") room.deadline += 10000; else p.inventory.push("time"); }
      else p.coins += 0;
    } else {
      p.inventory.push(powerId);
    }
    socket.emit("shop:bought", { powerId, message: "Achat effectué !" });
    emitRoom(room);
  });
  socket.on("power:use", ({ powerId, targetId } = {}) => {
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    if (!room || !p || !p.inventory.includes(powerId)) return sendError(socket, "Tu ne possèdes pas ce pouvoir.");
    if (room.status === "playing" && p.submitted) return sendError(socket, "Tu as déjà envoyé tes réponses.");
    if (powerId === "friend") {
      const target = room.players.get(targetId);
      if (!target || target.id === p.id) return sendError(socket, "Choisis un autre joueur.");
      if (target.shield) { target.shield = false; return sendError(socket, "Le bouclier a bloqué le pouvoir."); }
      io.to(target.id).emit("power:friend-request", { from: p.name });
      socket.emit("chat:private:notice", "Demande d'aide envoyée.");
    } else if (powerId === "spy") {
      const target = [...room.players.values()].find(x => x.id !== p.id);
      socket.emit("power:spy-result", { message: target ? `Catégorie révélée chez ${target.name} : ${room.categories[Math.floor(Math.random()*room.categories.length)]}` : "Aucun adversaire." });
    } else if (powerId === "change") {
      if (room.status !== "lobby") return sendError(socket, "Ce pouvoir est utilisable avant le début de la partie.");
      const idx = Math.floor(Math.random()*room.categories.length);
      const replacement = ["Film","Sport","Personnage fictif","Vêtement","Instrument","Plante"][Math.floor(Math.random()*6)];
      room.categories[idx] = replacement; system(room, `${p.name} a changé une catégorie !`);
    } else if (powerId === "time") {
      if (room.status !== "playing") return sendError(socket, "Le temps bonus s'utilise pendant une manche.");
      room.deadline += 10000;
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
    const room = rooms.get(socket.data.roomCode); const p = findPlayer(room, socket);
    if (!room || !p || room.hostId !== socket.id || room.status !== "results") return;
    if (room.round >= room.maxRounds) {
      room.status = "finished"; emitRoom(room); io.to(room.code).emit("game:finished", roomState(room)); return;
    }
    room.round++; startRound(room);
  });
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, "0.0.0.0", () => console.log(`Le Bac à Sable écoute sur le port ${PORT}`));
