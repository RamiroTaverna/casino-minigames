// public/client.js

const socket = io();

let siteInventory = [];
let userInventory = [];
let selectedUsers = []; // selección múltiple (usuario)
let selectedSites = []; // selección múltiple (sitio)
let isSpinning = false;
let lastAngle = 0; // para volver a 0° por la ruta corta

const $ = sel => document.querySelector(sel);

const userEl = $("#userInventory");
const siteEl = $("#siteInventory");
const ring = $("#ringProgress");
const chanceText = $("#chanceText");
const spinBtn = $("#spinBtn");
const arrow = $("#arrow");
const resultEl = $("#result");
const gameEl = $(".game");
const spinSound = $("#spinSound");
const spinWinSound = $("#spinWinSound");
const soundCheckbox = $("#sound-checkbox");

let soundEnabled = true;

soundCheckbox.addEventListener('change', () => {
  soundEnabled = soundCheckbox.checked;
});

const selectedUserListEl = $("#selectedUserList");
const selectedSiteListEl = $("#selectedSiteList");

// -------------------- Helpers selección --------------------

const hasId = (arr, id) => arr.some(it => it.id === id);

function toggleSelect(arr, item) {
  const i = arr.findIndex(x => x.id === item.id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(item);
}

function syncSelectionsWithInventories() {
  selectedUsers = selectedUsers.filter(su => userInventory.some(u => u.id === su.id));
  selectedSites  = selectedSites.filter(ss => siteInventory.some(s => s.id === ss.id));
}

// -------------------- Render / UI --------------------

function renderInventory(list, container, type) {
  container.innerHTML = "";
  list.forEach(it => {
    const card = document.createElement('div');
    const selected = type === 'user' ? hasId(selectedUsers, it.id) : hasId(selectedSites, it.id);
    card.className = 'card' + (selected ? ' selected' : '');
    card.dataset.id = it.id;
    card.innerHTML = `
      <img class="thumb" src="${it.img}" alt="${it.name}">
      <div class="name">${it.weapon} — ${it.name}</div>
      <div class="meta">
        <span>${it.rarity}</span>
        <span class="price">$${it.price.toFixed(2)}</span>
      </div>
    `;
    card.addEventListener('click', () => {
      if (isSpinning) return; // no permitir cambiar selección durante el spin
      if (type === 'user') toggleSelect(selectedUsers, it);
      else toggleSelect(selectedSites, it);
      updateSelection();
      renderInventory(userInventory, userEl, 'user');
      renderInventory(siteInventory, siteEl, 'site');
    });
    container.appendChild(card);
  });
}

// ---- Mini-cards en los rails laterales ----

function renderSelectedMiniLists() {
  renderMiniList(selectedUsers, selectedUserListEl, 'user');
  renderMiniList(selectedSites, selectedSiteListEl, 'site');
}

function renderMiniList(items, container, type) {
  container.innerHTML = '';
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'mini-card';
    el.innerHTML = `
      <button class="mini-remove" title="Quitar">×</button>
      <img class="mini-thumb" src="${it.img}" alt="${it.weapon} ${it.name}">
      <div class="mini-price">$${it.price.toFixed(2)}</div>
      <div class="mini-info">${it.weapon} — ${it.name}</div>
    `;

    el.querySelector('.mini-remove').addEventListener('click', () => {
      if (isSpinning) return;
      // Lógica centralizada para quitar un ítem
      const list = type === 'user' ? selectedUsers : selectedSites;
      const inventory = type === 'user' ? userInventory : siteInventory;
      const container = type === 'user' ? userEl : siteEl;
      toggleSelect(list, it); // Reutilizamos la función toggle
      updateSelection();
      renderInventory(inventory, container, type);
    });
    container.appendChild(el);
  });
}

function sumPrices(arr) {
  return arr.reduce((acc, it) => acc + (Number(it.price) || 0), 0);
}

function computeChanceClient() {
  const userTotal = sumPrices(selectedUsers);
  const siteTotal = sumPrices(selectedSites);
  if (userTotal <= 0 || siteTotal <= 0) return 0;
  const raw = (userTotal / siteTotal) * 100;
  const clamped = Math.max(1, Math.min(80, Math.floor(raw * 100) / 100)); // 2 decimales
  return clamped;
}

function setRing(percent) {
  const dash = 100 - percent; // pathLength=100
  ring.style.strokeDashoffset = dash.toString();
}

function updateSelection() {
  renderSelectedMiniLists();

  const chance = computeChanceClient();
  setRing(chance);
  chanceText.textContent = `${chance.toFixed(2)}%`;

  spinBtn.disabled = !(selectedUsers.length && selectedSites.length) || isSpinning;
}

function refreshUI() {
  renderInventory(userInventory, userEl, 'user');
  renderInventory(siteInventory, siteEl, 'site');
  syncSelectionsWithInventories();
  updateSelection();
}

// -------------------- Animaciones de flecha --------------------

const arrowPivot = document.getElementById('arrowPivot'); // ya lo estás usando?

function animateArrow(targetAngle){
  return new Promise(resolve => {
    const duration = 5000 + Math.random() * 500;
    const easing = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
    arrowPivot.style.transition = `transform ${duration}ms ${easing}`;
    requestAnimationFrame(() => {
      arrowPivot.style.transform = `rotate(${targetAngle}deg)`; // ⬅ pivot, no arrow
      setTimeout(() => {
        arrowPivot.style.transition = '';
        lastAngle = targetAngle;
        resolve();
      }, duration + 50);
    });
  });
}

function resetArrowSmart(delayMs = 2000){
  return new Promise(resolve => {
    setTimeout(() => {
      const mod = ((lastAngle % 360) + 360) % 360;
      const forward = (360 - mod) % 360;
      arrowPivot.style.transition = 'transform 0.9s ease-in-out';
      arrowPivot.style.transform = `rotate(${lastAngle + forward}deg)`;
      setTimeout(() => {
        arrowPivot.style.transition = 'none';
        arrowPivot.style.transform = 'rotate(0deg)';
        lastAngle = 0;
        resolve();
      }, 950);
    }, delayMs);
  });
}



// -------------------- Interacciones --------------------

spinBtn.addEventListener('click', () => {
  if (!selectedUsers.length || !selectedSites.length || isSpinning) return;

  if (soundEnabled) {
    spinSound.currentTime = 0;
    spinSound.play();
  }

  isSpinning = true;           // congelamos UI y mantenemos barra visible
  spinBtn.disabled = true;
  resultEl.textContent = 'Girando...';

  const userItemIds = selectedUsers.map(i => i.id);
  const siteItemIds = selectedSites.map(i => i.id);

  socket.emit('spin', { userItemIds, siteItemIds });
});

// -------------------- Sockets --------------------

socket.on('state', ({ siteInventory: s, userInventory: u }) => {
  siteInventory = s;
  userInventory = u;
  if (isSpinning) return; // ignorar updates mientras la flecha no volvió a 0
  refreshUI();
});

socket.on('spinResult', (data) => {
  if (!data.ok) {
    resultEl.textContent = data.error || 'Error';
    isSpinning = false;
    if (soundEnabled) {
      spinSound.pause();
    }
    refreshUI();
    return;
  }

  const { angle, win, roll } = data;

  // 1) girar hasta el resultado
  animateArrow(angle)
    // 2) mostrar resultado
    .then(() => {
      if (soundEnabled) {
        spinSound.pause();
        if (win) {
          spinWinSound.currentTime = 0;
          spinWinSound.play();
        }
      }
      gameEl.classList.add(win ? 'win-color' : 'lose-color');
      resultEl.innerHTML = `<small>Rolled: ${roll.toFixed(2)}%</small>`;

      // Mantener el mensaje hasta que termine la corrección del arrow
      return resetArrowSmart(2000).then(() => {
        resultEl.textContent = ''; // limpiar al finalizar el retorno
        gameEl.classList.remove('win-color', 'lose-color');
      });
    })
    // 3) cuando la flecha volvió a 0°, habilitar UI y refrescar
    .then(() => {
      isSpinning = false;
      // opcional: limpiar selecciones tras el giro (comentá si querés conservar)
      selectedUsers = [];
      selectedSites = [];
      refreshUI();
    });
});

// -------------------- Estado inicial --------------------

fetch('/api/state')
  .then(r => r.json())
  .then(data => {
    siteInventory = data.siteInventory;
    userInventory = data.userInventory;
    refreshUI();
  });
