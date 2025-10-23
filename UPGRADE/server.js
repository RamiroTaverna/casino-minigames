// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Utilidades ----------
const RARITIES = ['FN', 'MW', 'FT', 'WW', 'BS'];
const WEAPONS = [
  'AK-47','M4A1-S','Glock-18','USP-S','Desert Eagle','AWP','MAC-10','MP7','MP9',
  'Nova','PP-Bizon','SG 553','Tec-9','UMP-45','XM1014','Galil AR','P250','Sawed-Off','FAMAS','MAG-7'
];

function fromHashInt(str, mod){ // número estable basado en hash
  const h = crypto.createHash('sha1').update(str).digest();
  let n = 0;
  for (let i=0;i<4;i++) n = (n << 8) | h[i];
  return Math.abs(n) % mod;
}

function toTitle(s){
  return s
    .replace(/\.[a-z0-9]+$/i,'') // quitar extensión
    .replace(/[_\-]+/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .replace(/\b([a-z])/g, (_,c)=>c.toUpperCase());
}

// genera precio estable entre 0.10 y 4.00 en pasos de 0.01
function priceFromName(name){
  const cents = 10 + fromHashInt(name, 391); // 10..400
  return Number((cents/100).toFixed(2));
}

// ---------- Carga de artículos desde /public/articulos ----------
function loadItemsFromFolder() {
  const folder = path.join(__dirname, 'public', 'articulos');
  let files = [];
  try {
    files = fs.readdirSync(folder)
      .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
  } catch {
    files = [];
  }
  const items = files.map((file, idx) => {
    const base = file;
    const name = toTitle(base);
    const weapon = WEAPONS[fromHashInt(base, WEAPONS.length)];
    const rarity = RARITIES[fromHashInt(base, RARITIES.length)];
    const price = priceFromName(base);
    return {
      id: `it-${idx}-${base}`,
      name,
      weapon,
      rarity,
      price,
      img: `/articulos/${base}`
    };
  });
  return items;
}

// ---------- Estado (en memoria) ----------
const all = loadItemsFromFolder();
const split = Math.max(1, Math.floor(all.length / 2));
let userInventory = all.slice(0, split);
let siteInventory = all.slice(split);

// Si la carpeta está vacía, caemos a un ítem por defecto
if (all.length === 0) {
  userInventory = [{
    id: 'fallback-1', name: 'Default', weapon: 'Glock-18',
    rarity: 'FT', price: 0.2, img: '/articulos/default.png'
  }];
  siteInventory = [{
    id: 'fallback-2', name: 'Recoil Case', weapon: 'Case',
    rarity: 'MW', price: 0.41, img: '/articulos/recoil_case.png'
  }];
}

// chance % por suma de precios (1..80)
function computeChance(userItems, siteItems) {
  const u = userItems.reduce((a,it)=>a+it.price,0);
  const s = siteItems.reduce((a,it)=>a+it.price,0);
  if (u <= 0 || s <= 0) return 0;
  const raw = (u / s) * 100;
  return Math.max(1, Math.min(80, Math.floor(raw * 100) / 100));
}

// ---------- API ----------
app.get('/api/state', (req, res) => {
  res.json({ siteInventory, userInventory });
});

// opcional preview n:n
app.post('/api/preview', (req, res) => {
  const { userItemIds = [], siteItemIds = [] } = req.body || {};
  const u = userItemIds.map(id => userInventory.find(i=>i.id===id)).filter(Boolean);
  const s = siteItemIds.map(id => siteInventory.find(i=>i.id===id)).filter(Boolean);
  res.json({ chance: computeChance(u,s) });
});

// ---------- Sockets ----------
const spinningBySocket = new Set();

io.on('connection', (socket) => {
  socket.emit('state', { siteInventory, userInventory });

  socket.on('spin', ({ userItemIds = [], siteItemIds = [] }) => {
    if (spinningBySocket.has(socket.id)) {
      socket.emit('spinResult', { ok:false, error:'Ya hay un spin en curso.' });
      return;
    }
    spinningBySocket.add(socket.id);

    try {
      if (!Array.isArray(userItemIds) || !Array.isArray(siteItemIds) ||
          userItemIds.length === 0 || siteItemIds.length === 0) {
        socket.emit('spinResult', { ok:false, error:'Selecciona artículos válidos.' });
        return;
      }

      const userItems = userItemIds.map(id => userInventory.find(x => x.id === id)).filter(Boolean);
      const siteItems = siteItemIds.map(id => siteInventory.find(x => x.id === id)).filter(Boolean);
      if (userItems.length !== userItemIds.length || siteItems.length !== siteItemIds.length) {
        socket.emit('spinResult', { ok:false, error:'Algunos artículos ya no están disponibles.' });
        return;
      }

      const chance = computeChance(userItems, siteItems);
      const roll = Math.random() * 100;
      const win = roll < chance;

      const baseRot = 6 + Math.floor(Math.random() * 4);
      const finalAngle = (roll / 100) * 360;
      const angle = baseRot * 360 + finalAngle;

      // transferencias n:n
      if (win) {
        // GANA: todos los del sitio -> usuario (los del usuario quedan)
        siteItems.forEach(si => {
          const idx = siteInventory.findIndex(x => x.id === si.id);
          if (idx >= 0) userInventory.push(siteInventory.splice(idx, 1)[0]);
        });
      } else {
        // PIERDE: todos los del usuario -> sitio
        userItems.forEach(ui => {
          const idx = userInventory.findIndex(x => x.id === ui.id);
          if (idx >= 0) siteInventory.push(userInventory.splice(idx, 1)[0]);
        });
      }

      // “provably fair” simple
      const serverSeed = crypto.randomBytes(16).toString('hex');
      const nonce = Date.now().toString();
      const proof = crypto.createHash('sha256').update(serverSeed + nonce).digest('hex');

      socket.emit('spinResult', {
        ok:true, chance, win, roll:+roll.toFixed(4), angle:+angle.toFixed(2),
        proof, serverSeed, nonce, userItems, siteItems
      });

      io.emit('state', { siteInventory, userInventory });

    } catch (e) {
      console.error(e);
      socket.emit('spinResult', { ok:false, error:'Error del servidor.' });
    } finally {
      spinningBySocket.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Upgrade game server running on http://localhost:' + PORT);
});