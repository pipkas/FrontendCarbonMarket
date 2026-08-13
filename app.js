/* ==========================================================================
   Carbon Market — фронтенд без сборки (vanilla JS), работает поверх
   FastAPI-бэкенда на отдельном origin. Адрес API берётся из config.js.
   ========================================================================== */

const API_BASE_URL = (window.CARBON_MARKET_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

const state = {
  token: localStorage.getItem("cm_token") || null,
  user: JSON.parse(localStorage.getItem("cm_user") || "null"),
};

// Действие, отложенное до успешного входа (например, "купить", если
// человек нажал «Купить», не будучи авторизован — после входа сразу
// выполняем то, что он изначально хотел).
let pendingAction = null;

const PROJECT_TYPES = [
  ["", "Любой тип проекта"],
  ["RENEWABLE_ENERGY", "ВИЭ"],
  ["FORESTRY", "Лесоклиматический"],
  ["METHANE_CAPTURE", "Улавливание метана"],
  ["ENERGY_EFFICIENCY", "Энергоэффективность"],
  ["WASTE_MANAGEMENT", "Утилизация отходов"],
  ["OTHER", "Другое"],
];

const UNIT_STATUSES = [
  ["", "Любой статус"],
  ["ISSUED", "Выпущена"],
  ["FROZEN", "Заморожена"],
  ["RETIRED", "Погашена"],
  ["TRANSFERRED", "Передана"],
];

const PROJECT_TYPE_LABELS = Object.fromEntries(PROJECT_TYPES.filter(([v]) => v));
const STATUS_LABELS = Object.fromEntries(UNIT_STATUSES.filter(([v]) => v));

const SCENARIO_LABELS = {
  BUY_EXACT_QUANTITY: "Точный объём",
  INVEST_AMOUNT: "Инвестиция по бюджету",
};

const LISTING_STATUS_LABELS = { ACTIVE: "Активно", SOLD: "Продано", CANCELLED: "Отменено" };
const LISTING_STATUS_CSS = { ACTIVE: "active", SOLD: "sold_out", CANCELLED: "cancelled" };

const VOUCHER_STATUS_LABELS = { ACTIVE: "Активен", REDEEMED: "Погашен" };
const VOUCHER_STATUS_CSS = { ACTIVE: "active", REDEEMED: "sold_out" };

/* ---------------------------- API-хелпер ---------------------------- */

async function api(path, { method = "GET", body, auth = true, query } = {}) {
  let url = path;
  if (query) {
    const usp = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") usp.append(k, v); });
    const qs = usp.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  const headers = {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true"
    };
  if (auth && state.token) headers["Authorization"] = `Bearer ${state.token}`;

  const res = await fetch(apiUrl(url), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });

  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }

  if (res.status === 401 && auth) {
    // Токен истёк/невалиден — очищаем и перенаправляем на страницу входа.
    localStorage.removeItem("cm_token");
    localStorage.removeItem("cm_user");
    window.location.replace("login.html");
  }

  if (!res.ok) {
    const message = data?.detail || data?.error || `Ошибка запроса (${res.status})`;
    const err = new Error(message);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------------------- Toast ---------------------------- */

let toastTimer = null;
function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.toggle("toast--error", isError);
  el.classList.toggle("toast--success", !isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* ============================================================
   АВТОРИЗАЦИЯ: модалка по кнопке, меню профиля, requireAuth()
   ============================================================ */

function initAuthTabs() {
  document.querySelectorAll("[data-authtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-authtab]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const target = btn.dataset.authtab;
      document.getElementById("login-form").hidden = target !== "login";
      document.getElementById("register-form").hidden = target !== "register";
      document.getElementById("auth-error").hidden = true;
    });
  });

  const userTypeSelect = document.querySelector('#register-form [name="user_type"]');
  userTypeSelect.addEventListener("change", () => {
    const isLegal = userTypeSelect.value === "LEGAL_ENTITY";
    document.querySelectorAll("[data-legal-only]").forEach((el) => { el.hidden = !isLegal; });
  });
}

function openAuthModal(note) {
  const overlay = document.getElementById("auth-modal-overlay");
  const noteEl = document.getElementById("auth-modal-note");
  if (note) { noteEl.textContent = note; noteEl.hidden = false; } else { noteEl.hidden = true; }
  document.getElementById("auth-error").hidden = true;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

// Закрывает окно, НЕ трогая pendingAction — оно должно пережить закрытие
// модалки внутри onAuthSuccess (успешный вход выполняет отложенное
// действие сразу после закрытия окна).
function closeAuthModal() {
  document.getElementById("auth-modal-overlay").hidden = true;
  document.body.style.overflow = "";
}

// А это — явная отмена: человек закрыл окно сам, не завершив вход,
// поэтому то, что он пытался сделать, тоже отменяем.
function cancelAuthModal() {
  closeAuthModal();
  pendingAction = null;
}

document.getElementById("open-auth-btn").addEventListener("click", () => openAuthModal());
document.getElementById("close-auth-btn").addEventListener("click", cancelAuthModal);
document.getElementById("auth-modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "auth-modal-overlay") cancelAuthModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("auth-modal-overlay").hidden) cancelAuthModal();
});
document.querySelectorAll("[data-open-auth]").forEach((btn) => btn.addEventListener("click", () => openAuthModal()));

function showAuthError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.hidden = false;
}

function onAuthSuccess(data) {
  state.token = data.token;
  state.user = { id: data.user_id, user_type: data.user_type, display_name: data.display_name };
  localStorage.setItem("cm_token", state.token);
  localStorage.setItem("cm_user", JSON.stringify(state.user));
  closeAuthModal();
  refreshAuthUI();
  toast(`Добро пожаловать, ${state.user.display_name}!`);

  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    action();
  } else {
    loadListings();
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/login", { method: "POST", auth: false, body: { email: fd.get("email"), password: fd.get("password") } });
    onAuthSuccess(data);
  } catch (err) { showAuthError(err.message); }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/register", { method: "POST", auth: false, body: {
      email: fd.get("email"), password: fd.get("password"), user_type: fd.get("user_type"),
      display_name: fd.get("display_name"), inn: fd.get("inn") || null, ogrn: fd.get("ogrn") || null,
    }});
    onAuthSuccess(data);
  } catch (err) { showAuthError(err.message); }
});

/* --- меню профиля --- */
document.getElementById("user-chip-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("user-menu");
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", () => { document.getElementById("user-menu").hidden = true; });

document.getElementById("logout-btn").addEventListener("click", handleLoggedOut);

document.getElementById("user-menu-profile").addEventListener("click", () => {
  document.getElementById("user-menu").hidden = true;
  goToView("profile");
});

function handleLoggedOut() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("cm_token");
  localStorage.removeItem("cm_user");
  window.location.replace("login.html");
}

function refreshAuthUI() {
  const loggedIn = !!state.token;
  document.getElementById("open-auth-btn").hidden = loggedIn;
  document.getElementById("user-chip").hidden = !loggedIn;
  if (loggedIn) {
    document.getElementById("user-chip-name").textContent = state.user.display_name;
    document.getElementById("user-menu-name").textContent = state.user.display_name;
    document.getElementById("user-menu-type").textContent = state.user.user_type === "LEGAL_ENTITY" ? "Юридическое лицо" : "Физическое лицо";
    document.getElementById("user-avatar").textContent = state.user.display_name.trim().charAt(0).toUpperCase() || "A";
  }
  renderAuthGates();
}

/** Требует авторизации для действия; если не авторизован — открывает
 *  модалку и откладывает действие на момент успешного входа. */
function requireAuth(action) {
  if (state.token) { action(); return; }
  pendingAction = action;
  openAuthModal("Войдите, чтобы завершить это действие.");
}

/* ============================================================
   НАВИГАЦИЯ ПО РАЗДЕЛАМ
   ============================================================ */

function goToView(view) {
  document.querySelectorAll(".topnav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
  document.getElementById(`view-${view}`).classList.add("is-active");

  if (view === "market") loadListings();
  if (view === "listings" && state.token) { loadMyUnlistedVouchers(); loadMyListings(); }
  if (view === "vouchers" && state.token) loadMyVouchers();
  if (view === "history" && state.token) loadHistory();
  if (view === "profile" && state.token) loadProfile();
}

document.querySelectorAll("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => goToView(btn.dataset.view));
});

/** «Мои объявления», «Мои векселя», «История» — приватные разделы: если человек не
 *  авторизован, вместо контента показываем приглашение войти. */
function renderAuthGates() {
  const loggedIn = !!state.token;
  document.getElementById("listings-authgate").hidden = loggedIn;
  document.getElementById("listings-authcontent").hidden = !loggedIn;
  document.getElementById("vouchers-authgate").hidden = loggedIn;
  document.getElementById("vouchers-authcontent").hidden = !loggedIn;
  document.getElementById("history-authgate").hidden = loggedIn;
  document.getElementById("history-authcontent").hidden = !loggedIn;
  document.getElementById("profile-authgate").hidden = loggedIn;
  document.getElementById("profile-authcontent").hidden = !loggedIn;
}

/* ============================================================
   Поля фильтра характеристик (используются в 4 местах)
   ============================================================ */

function renderCharacteristicsFields(container) {
  container.innerHTML = `
    <label class="field"><span>Название проекта</span><input type="text" name="project_name" placeholder="например, Реликтовый лес"></label>
    <label class="field"><span>Тип проекта</span><select name="project_type">${PROJECT_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    <label class="field"><span>Год выпуска</span><input type="number" name="vintage_year" placeholder="2024"></label>
    <label class="field"><span>Методология</span><input type="text" name="methodology" placeholder="например, VM0007"></label>
    <label class="field"><span>Верификатор</span><input type="text" name="verifier" placeholder="например, TÜV Nord"></label>
    <label class="field"><span>Страна/регион</span><input type="text" name="country" placeholder="например, RU"></label>
    <label class="field"><span>Дата выпуска</span><input type="date" name="issue_date"></label>
    <label class="field"><span>Статус</span><select name="status">${UNIT_STATUSES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
  `;
}

function readCharacteristicsFields(container) {
  const out = {};
  container.querySelectorAll("[name]").forEach((el) => { if (el.value) out[el.name] = el.value; });
  return out;
}

document.querySelectorAll("[data-filter-fields]").forEach(renderCharacteristicsFields);

function characteristicsTags(c) {
  const tags = [];
  if (c.project_type) tags.push(PROJECT_TYPE_LABELS[c.project_type] || c.project_type);
  if (c.vintage_year) tags.push(`Выпуск ${c.vintage_year}`);
  if (c.methodology) tags.push(c.methodology);
  if (c.country) tags.push(c.country);
  if (c.verifier) tags.push(`Верификатор: ${c.verifier}`);
  if (c.status) tags.push(STATUS_LABELS[c.status] || c.status);
  return tags;
}

/** Кликабельный номер векселя — ведёт на вкладку «Проверить вексель» и сразу ищет его. */
function voucherNumberBadge(number) {
  return `<button type="button" class="voucher-number-btn" onclick="openVoucherLookup('${number}')">${number}</button>`;
}

function openVoucherLookup(number) {
  goToView("verify");
  const input = document.querySelector('#verify-form [name="number"]');
  input.value = number;
  runVoucherLookup(number);
}

/* ============================================================
   ВИТРИНА: карточки объявлений (публично)
   ============================================================ */

function listingCard(listing) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = `
    <div class="card-project">${listing.characteristics.project_name || "Без названия проекта"}</div>
    <div class="card-seller">Продавец: <button type="button" class="qi-seller-link" data-seller>${listing.seller_display_name}</button></div>
    <div style="margin:2px 0 10px">${voucherNumberBadge(listing.voucher_number)}</div>
    <div class="card-tags">${characteristicsTags(listing.characteristics).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
    <div class="card-rows">
      <div class="card-row"><span>Цена за вексель</span><b class="price">${listing.fixed_price.toFixed(2)} ₽</b></div>
      <div class="card-row"><span>Объём</span><b>${listing.quantity} УЕ</b></div>
      <div class="card-row"><span>Цена за единицу</span><b>${listing.price_per_unit.toFixed(2)} ₽/УЕ</b></div>
    </div>
    <div class="card-foot">
      <button class="btn btn--primary btn--sm" data-buy style="width:100%">Купить</button>
    </div>
  `;
  wrap.querySelector("[data-buy]").addEventListener("click", () => {
    requireAuth(() => doBuyListing(listing.id));
  });
  wrap.querySelector("[data-seller]").addEventListener("click", () => openSellerProfile(listing.seller_id));
  return wrap;
}

async function doBuyListing(listingId) {
  try {
    const voucher = await api("/market/buy-listing", { method: "POST", body: { listing_id: listingId } });
    toast(`Вексель ${voucher.number} куплен за ${voucher.price_paid.toFixed(2)} ₽ — смотрите «Мои векселя».`);
    loadListings();
  } catch (err) { toast(err.message, true); }
}

async function loadListings() {
  const grid = document.getElementById("listings-grid");
  grid.innerHTML = `<p class="empty-row">Загружаю предложения…</p>`;
  const sortBy = document.getElementById("sort-by").value;
  const filterContainer = document.querySelector('[data-filter-fields="browse"]');
  const filters = readCharacteristicsFields(filterContainer);
  try {
    const listings = await api("/listings", { auth: false, query: { ...filters, sort_by: sortBy } });
    grid.innerHTML = "";
    if (!listings.length) { grid.innerHTML = `<p class="empty-row">Подходящих предложений пока нет.</p>`; return; }
    listings.forEach((l) => grid.appendChild(listingCard(l)));
  } catch (err) {
    grid.innerHTML = `<p class="empty-row">${err.message}</p>`;
  }
}

document.getElementById("sort-by").addEventListener("change", loadListings);
document.getElementById("refresh-listings").addEventListener("click", loadListings);
document.getElementById("apply-browse-filter").addEventListener("click", loadListings);

/* ============================================================
   ПОДБОР ПРЕДЛОЖЕНИЙ (превью топ-5 ДО покупки) — аккордеон-карточки
   ============================================================ */

function quoteOfferCard(offer, idx) {
  const tags = characteristicsTags(offer.characteristics);
  const c = offer.characteristics;
  const details = [
    c.methodology && `Методология: ${c.methodology}`,
    c.verifier    && `Верификатор: ${c.verifier}`,
    c.vintage_year && `Год выпуска: ${c.vintage_year}`,
    c.country     && `Страна: ${c.country}`,
    c.issue_date  && `Дата выпуска: ${c.issue_date}`,
  ].filter(Boolean);

  return `
    <div class="qi" id="qi-${idx}">
      <button class="qi-head" type="button" onclick="toggleQi(${idx})">
        <div class="qi-left">
          <div class="qi-project">${offer.characteristics.project_name || "Без названия проекта"} · ${offer.voucher_number}</div>
          <div class="qi-seller">
            <button class="qi-seller-link" type="button" onclick="event.stopPropagation();openSellerProfile('${offer.seller_id}')">${offer.seller_display_name}</button>
          </div>
        </div>
        <div class="qi-right">
          <span class="qi-qty">${offer.quantity} УЕ</span>
          <span class="qi-price">${offer.price_per_unit.toFixed(2)} ₽/ед</span>
          <span class="qi-subtotal">${offer.fixed_price.toFixed(2)} ₽</span>
          <svg class="qi-chevron" viewBox="0 0 20 20" width="14" height="14"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </button>
      <div class="qi-body" id="qi-body-${idx}" hidden>
        ${tags.length ? `<div class="quote-tags" style="margin-bottom:8px">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
        ${details.map((d) => `<div class="qi-detail-row">${d}</div>`).join("")}
        <div class="qi-detail-row">Вексель: ${voucherNumberBadge(offer.voucher_number)}</div>
        <button class="btn btn--ghost btn--sm" style="margin-top:10px" type="button"
          onclick="openSellerProfile('${offer.seller_id}')">Профиль продавца →</button>
      </div>
    </div>
  `;
}

function toggleQi(idx) {
  const body = document.getElementById(`qi-body-${idx}`);
  const chevron = document.querySelector(`#qi-${idx} .qi-chevron`);
  body.hidden = !body.hidden;
  if (chevron) chevron.style.transform = body.hidden ? "" : "rotate(180deg)";
}

function renderQuote(quote, mode, requestBody) {
  const container = document.getElementById("quote-result");

  if (!quote.offers.length) {
    container.hidden = false;
    container.innerHTML = `<p class="empty-row">Подходящих предложений не нашлось — попробуйте изменить количество, бюджет или характеристики.</p>`;
    return;
  }

  let warning = "";
  if (mode === "quantity" && quote.unmet_quantity > 0) {
    warning = `<div class="quote-warning">На рынке пока нет достаточного объёма: удастся набрать ${quote.total_quantity} из ${requestBody.quantity_needed} УЕ (векселя неделимы — точное совпадение не всегда возможно).</div>`;
  }
  if (mode === "budget" && quote.leftover_budget > 0) {
    warning = `<div class="quote-warning">${quote.leftover_budget.toFixed(2)} ₽ из бюджета останется неизрасходовано — оставшиеся векселя дороже, чем этот остаток.</div>`;
  }

  container.hidden = false;
  container.innerHTML = `
    <div class="quote-head">
      <h3>Оптимальная раскладка</h3>
      <div class="quote-total">${quote.total_quantity} УЕ · ${quote.total_price.toFixed(2)} ₽</div>
    </div>
    ${warning}
    <div class="qi-list">${quote.offers.map((o, i) => quoteOfferCard(o, i)).join("")}</div>
    <div class="quote-foot" style="margin-top:16px">
      <span></span>
      <button class="btn btn--primary" id="confirm-quote-btn">Подтвердить и купить ${quote.total_price.toFixed(2)} ₽</button>
    </div>
  `;

  document.getElementById("confirm-quote-btn").addEventListener("click", () => {
    requireAuth(() => doConfirmPurchase(mode, requestBody));
  });

  container.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function doConfirmPurchase(mode, requestBody) {
  const path = mode === "quantity" ? "/market/buy-exact-quantity" : "/market/invest-amount";
  try {
    const result = await api(path, { method: "POST", body: requestBody });
    const numbers = result.vouchers.map((v) => v.number).join(", ");
    toast(`Готово: ${result.total_quantity} УЕ за ${result.total_price.toFixed(2)} ₽. Куплены вексели: ${numbers} — смотрите «Мои векселя».`);
    document.getElementById("quote-result").hidden = true;
    loadListings();
  } catch (err) {
    if (err.payload?.error === "insufficient_market_supply") {
      toast(`На рынке недостаточно предложений: максимум ${err.payload.best_available} УЕ.`, true);
    } else {
      toast(err.message, true);
    }
  }
}

document.getElementById("find-by-quantity-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const quantity = parseInt(new FormData(form).get("quantity_needed"), 10);
  const filters = readCharacteristicsFields(form.querySelector("[data-filter-fields]"));
  const body = { quantity_needed: quantity, characteristics: Object.keys(filters).length ? filters : null };
  try {
    const quote = await api("/market/quote/buy-exact-quantity", { method: "POST", body });
    renderQuote(quote, "quantity", body);
  } catch (err) { toast(err.message, true); }
});

document.getElementById("find-by-budget-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const budget = Number(new FormData(form).get("budget_amount"));
  const filters = readCharacteristicsFields(form.querySelector("[data-filter-fields]"));
  const body = { budget_amount: budget, characteristics: Object.keys(filters).length ? filters : null };
  try {
    const quote = await api("/market/quote/invest-amount", { method: "POST", body });
    renderQuote(quote, "budget", body);
  } catch (err) { toast(err.message, true); }
});

/* ============================================================
   ПРОФИЛЬ ПРОДАВЦА — модальное окно
   ============================================================ */

async function openSellerProfile(sellerId) {
  const overlay = document.getElementById("seller-modal-overlay");
  const content = document.getElementById("seller-modal-content");
  content.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const data = await api(`/listings/seller/${sellerId}`, { auth: false });
    const typeLabel = data.user_type === "LEGAL_ENTITY" ? "Юридическое лицо" : "Физическое лицо";
    const listingsHtml = data.active_listings.length
      ? data.active_listings.map((l) => `
            <div class="seller-listing-row">
              <div>
                <div class="seller-listing-project">${l.characteristics.project_name || "Без названия"}</div>
                <div style="margin:3px 0 6px">${voucherNumberBadge(l.voucher_number)}</div>
                <div class="seller-listing-tags">${characteristicsTags(l.characteristics).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div class="seller-listing-price">${l.fixed_price.toFixed(2)} ₽</div>
                <div class="seller-listing-qty">${l.quantity} УЕ · ${l.price_per_unit.toFixed(2)} ₽/УЕ</div>
              </div>
            </div>
          `).join("")
      : `<p class="empty-row" style="padding:16px 0">Нет активных объявлений.</p>`;

    content.innerHTML = `
      <div class="seal seal--lg" aria-hidden="true">
        <svg viewBox="0 0 120 120"><path d="M 60,60 m -46,0 a 46,46 0 1,1 92,0 a 46,46 0 1,1 -92,0"/></svg>
        <span class="seal-year">УЕ</span>
      </div>
      <h2 id="seller-modal-title" style="margin-bottom:4px">${data.display_name}</h2>
      <div style="font-size:13px;color:var(--ink-soft);margin-bottom:24px">${typeLabel}</div>
      <div class="eyebrow" style="margin-bottom:10px">Активные объявления</div>
      <div class="seller-listings">${listingsHtml}</div>
    `;
  } catch (err) {
    content.innerHTML = `<p class="empty-row">Не удалось загрузить профиль: ${err.message}</p>`;
  }
}

document.getElementById("close-seller-btn").addEventListener("click", () => {
  document.getElementById("seller-modal-overlay").hidden = true;
  document.body.style.overflow = "";
});
document.getElementById("seller-modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "seller-modal-overlay") {
    e.target.hidden = true;
    document.body.style.overflow = "";
  }
});

/* ============================================================
   ПРОДАВЕЦ: выпуск векселя, выставление его на продажу, список объявлений
   ============================================================ */

document.getElementById("check-capacity-btn").addEventListener("click", async () => {
  const container = document.querySelector('[data-filter-fields="mint"]');
  const filters = readCharacteristicsFields(container);
  const result = document.getElementById("capacity-result");
  try {
    const res = await api("/vouchers/mint/available-capacity", { query: filters });
    result.textContent = `Доступно для выпуска векселя по этим характеристикам: ${res.available_quantity} УЕ.`;
  } catch (err) { result.textContent = err.message; }
});

document.getElementById("mint-voucher-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const characteristics = readCharacteristicsFields(form.querySelector('[data-filter-fields="mint"]'));
  const body = { characteristics, quantity: Number(fd.get("quantity")) };
  try {
    const voucher = await api("/vouchers/mint", { method: "POST", body });
    toast(`Вексель ${voucher.number} выпущен на ${voucher.quantity} УЕ. Теперь его можно выставить на продажу ниже.`);
    form.reset();
    document.getElementById("capacity-result").textContent = "";
    loadMyUnlistedVouchers();
  } catch (err) { toast(err.message, true); }
});

/** Векселя, которые пользователь держит и которые ещё не выставлены на продажу. */
async function loadMyUnlistedVouchers() {
  const container = document.getElementById("my-unlisted-vouchers");
  container.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  try {
    const vouchers = await api("/vouchers/mine");
    const unlisted = vouchers.filter((v) => v.status === "ACTIVE" && !v.active_listing);
    if (!unlisted.length) { container.innerHTML = `<p class="empty-row">Нет выпущенных векселей, доступных для выставления — сначала выпустите вексель в шаге 1.</p>`; return; }
    container.innerHTML = unlisted.map((v) => `
      <div class="uv-row" data-row="${v.id}">
        <div class="uv-left">
          <div class="uv-project">${v.characteristics.project_name || "Без названия"} · ${voucherNumberBadge(v.number)}</div>
          <div class="uv-meta">${v.quantity} УЕ ${v.price_paid != null ? `· куплен за ${v.price_paid.toFixed(2)} ₽` : "· выпущен вами"}</div>
        </div>
        <div class="uv-foot">
          <input type="number" min="0" step="0.01" placeholder="цена, ₽" data-price>
          <button class="btn btn--primary btn--sm" data-list-voucher="${v.id}">Выставить</button>
        </div>
      </div>
    `).join("");
    container.querySelectorAll("[data-list-voucher]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-row]");
        const price = Number(row.querySelector("[data-price]").value);
        if (!price || price <= 0) { toast("Укажите цену за вексель", true); return; }
        try {
          await api("/listings", { method: "POST", body: { voucher_id: btn.dataset.listVoucher, fixed_price: price } });
          toast("Вексель выставлен на продажу.");
          loadMyUnlistedVouchers();
          loadMyListings();
        } catch (err) { toast(err.message, true); }
      });
    });
  } catch (err) { container.innerHTML = `<p class="empty-row">${err.message}</p>`; }
}

async function loadMyListings() {
  const container = document.getElementById("my-listings-table");
  container.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  try {
    const listings = await api("/listings/mine");
    if (!listings.length) { container.innerHTML = `<p class="empty-row">Вы ещё не выставляли объявлений — выпустите и выставьте вексель выше.</p>`; return; }
    const rows = listings.map((l) => `
      <tr>
        <td>${voucherNumberBadge(l.voucher_number)}</td>
        <td>${l.characteristics.project_name || "—"}</td>
        <td class="num">${l.quantity} УЕ</td>
        <td class="num">${l.fixed_price.toFixed(2)} ₽ <span style="color:var(--ink-soft)">(${l.price_per_unit.toFixed(2)} ₽/УЕ)</span></td>
        <td><span class="status-pill status-pill--${LISTING_STATUS_CSS[l.status] || "active"}">${LISTING_STATUS_LABELS[l.status] || l.status}</span></td>
        <td>${l.status === "ACTIVE" ? `<button class="btn btn--danger btn--sm" data-cancel="${l.id}">Снять</button>` : ""}</td>
      </tr>
    `).join("");
    container.innerHTML = `
      <table>
        <thead><tr><th>Вексель</th><th>Проект</th><th>Объём</th><th>Цена</th><th>Статус</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    container.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try { await api(`/listings/${btn.dataset.cancel}`, { method: "DELETE" }); toast("Объявление снято с продажи."); loadMyListings(); loadMyUnlistedVouchers(); }
        catch (err) { toast(err.message, true); }
      });
    });
  } catch (err) { container.innerHTML = `<p class="empty-row">${err.message}</p>`; }
}

/* ============================================================
   ПОКУПАТЕЛЬ / ДЕРЖАТЕЛЬ: мои векселя — каждый со своим номером
   ============================================================ */

function voucherCard(v) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  const isRedeemed = v.status === "REDEEMED";
  const origin = v.price_paid != null
    ? `Куплен за ${v.price_paid.toFixed(2)} ₽`
    : "Выпущен вами";
  const historyNote = v.owners_count > 0 ? `Сменил ${v.owners_count} ${v.owners_count === 1 ? "владельца" : "владельцев"}` : "Первый держатель";

  wrap.innerHTML = `
    <div class="card-project">${v.characteristics.project_name || "Без названия проекта"}</div>
    <div style="margin:2px 0 8px">${voucherNumberBadge(v.number)}</div>
    <div class="card-tags">
      <span class="status-pill status-pill--${VOUCHER_STATUS_CSS[v.status] || "active"}">${VOUCHER_STATUS_LABELS[v.status] || v.status}</span>
      ${v.active_listing ? `<span class="tag">Выставлен за ${v.active_listing.fixed_price.toFixed(2)} ₽</span>` : ""}
    </div>
    <div class="card-rows">
      <div class="card-row"><span>Объём</span><b>${v.quantity} УЕ</b></div>
      <div class="card-row"><span>Происхождение</span><b>${origin}</b></div>
      <div class="card-row"><span>История</span><b>${historyNote}</b></div>
      <div class="card-row"><span>Выпущен</span><b>${new Date(v.created_at).toLocaleDateString("ru-RU")}</b></div>
    </div>
    <div class="voucher-card-foot" data-actions></div>
  `;

  const actions = wrap.querySelector("[data-actions]");

  if (isRedeemed) {
    actions.innerHTML = `<span style="font-size:12px;color:var(--forest)">✓ УЕ зачислены на баланс</span>`;
  } else if (v.active_listing) {
    actions.innerHTML = `<button class="btn btn--ghost btn--sm" data-unlist="${v.active_listing.listing_id}">Снять с продажи</button>`;
    actions.querySelector("[data-unlist]").addEventListener("click", async () => {
      try { await api(`/listings/${v.active_listing.listing_id}`, { method: "DELETE" }); toast("Снято с продажи."); loadMyVouchers(); }
      catch (err) { toast(err.message, true); }
    });
  } else {
    actions.innerHTML = `
      <button class="btn btn--primary btn--sm" data-redeem="${v.id}">Обналичить — зачислить УЕ</button>
      <div class="voucher-list-row">
        <input type="number" min="0" step="0.01" placeholder="цена, ₽" data-price>
        <button class="btn btn--ghost btn--sm" data-list="${v.id}">Продать</button>
      </div>
    `;
    actions.querySelector("[data-redeem]").addEventListener("click", async () => {
      try { await api(`/vouchers/${v.id}/redeem`, { method: "POST" }); toast("Вексель обналичен — УЕ зачислены на ваш баланс в реестре."); loadMyVouchers(); }
      catch (err) { toast(err.message, true); }
    });
    actions.querySelector("[data-list]").addEventListener("click", async () => {
      const price = Number(actions.querySelector("[data-price]").value);
      if (!price || price <= 0) { toast("Укажите цену за вексель", true); return; }
      try { await api("/listings", { method: "POST", body: { voucher_id: v.id, fixed_price: price } }); toast("Вексель выставлен на продажу."); loadMyVouchers(); }
      catch (err) { toast(err.message, true); }
    });
  }

  return wrap;
}

async function loadMyVouchers() {
  const grid = document.getElementById("vouchers-list");
  grid.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  try {
    const vouchers = await api("/vouchers/mine");
    if (!vouchers.length) { grid.innerHTML = `<p class="empty-row">У вас пока нет векселей — купите на витрине или выпустите свой во вкладке «Мои объявления».</p>`; return; }
    grid.innerHTML = "";
    vouchers.forEach((v) => grid.appendChild(voucherCard(v)));
  } catch (err) { grid.innerHTML = `<p class="empty-row">${err.message}</p>`; }
}

/* ============================================================
   ПРОВЕРКА ВЕКСЕЛЯ ПО НОМЕРУ — публично, без авторизации
   ============================================================ */

const TRANSFER_TYPE_LABELS = { MINT: "Выпуск векселя", SALE: "Покупка", CANCELLATION: "Возврат (отмена покупки)" };

function voucherTimelineStep(t, isLast) {
  const isCancel = t.type === "CANCELLATION";
  const label = t.type === "MINT"
    ? `Выпущен продавцом ${t.to_display_name}`
    : t.type === "SALE"
      ? `${t.to_display_name} купил у ${t.from_display_name}`
      : `${t.to_display_name} вернул вексель ${t.from_display_name}`;
  return `
    <div class="vp-step">
      <div class="vp-step-rail">
        <div class="vp-step-dot${isCancel ? " vp-step-dot--cancel" : ""}"></div>
        ${isLast ? "" : `<div class="vp-step-line"></div>`}
      </div>
      <div class="vp-step-body">
        <div class="vp-step-label">${TRANSFER_TYPE_LABELS[t.type] || t.type}: ${label}</div>
        <div class="vp-step-meta">${new Date(t.transferred_at).toLocaleString("ru-RU")}</div>
        ${t.price != null ? `<div class="vp-step-price">${t.price.toFixed(2)} ₽</div>` : ""}
      </div>
    </div>
  `;
}

function renderVoucherHistory(data) {
  const v = data.voucher;
  const container = document.getElementById("verify-result");
  container.innerHTML = `
    <div class="voucher-passport">
      <div class="vp-head">
        <div>
          <div class="vp-number">${v.number}</div>
          <div class="vp-project">${v.characteristics.project_name || "Без названия проекта"}</div>
        </div>
        <span class="status-pill status-pill--${VOUCHER_STATUS_CSS[v.status] || "active"}">${VOUCHER_STATUS_LABELS[v.status] || v.status}</span>
      </div>
      <div class="card-tags">${characteristicsTags(v.characteristics).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
      <div class="card-rows">
        <div class="card-row"><span>Объём</span><b>${v.quantity} УЕ</b></div>
        <div class="card-row"><span>Продавец-эмитент</span><b>${v.original_seller_display_name}</b></div>
        <div class="card-row"><span>Текущий держатель</span><b>${v.current_holder_display_name}</b></div>
        <div class="card-row"><span>Сменил владельцев</span><b>${v.owners_count}</b></div>
        ${v.active_listing ? `<div class="card-row"><span>Сейчас продаётся за</span><b class="price">${v.active_listing.fixed_price.toFixed(2)} ₽</b></div>` : ""}
      </div>
      <div class="vp-chain">
        <div class="vp-chain-title">История держателей</div>
        <div class="vp-timeline">
          ${data.chain.map((t, i) => voucherTimelineStep(t, i === data.chain.length - 1)).join("")}
        </div>
      </div>
    </div>
  `;
}

async function runVoucherLookup(number) {
  const container = document.getElementById("verify-result");
  container.innerHTML = `<p class="empty-row">Ищу вексель…</p>`;
  try {
    const data = await api(`/vouchers/number/${encodeURIComponent(number)}`, { auth: false });
    renderVoucherHistory(data);
  } catch (err) {
    container.innerHTML = `<p class="empty-row">${err.message}</p>`;
  }
}

document.getElementById("verify-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const number = new FormData(e.target).get("number").trim();
  if (!number) return;
  runVoucherLookup(number);
});

/* ============================================================
   ИСТОРИЯ — единая лента активности (покупки, продажи по своим
   объявлениям, создание/снятие объявлений, обналичивание/отмена)
   ============================================================ */

const ACTIVITY_TYPE_LABELS = {
  VOUCHER_MINTED: "Вексель выпущен",
  LISTING_CREATED: "Объявление создано",
  LISTING_CANCELLED: "Объявление снято",
  SALE: "Продажа — у вас купили",
  SALE_CANCELLED: "Продажа отменена покупателем",
  PURCHASE: "Покупка",
  VOUCHER_REDEEMED: "Вексель обналичен",
  VOUCHER_CANCELLED: "Покупка отменена",
};
const ACTIVITY_TYPE_CSS = {
  VOUCHER_MINTED: "active",
  LISTING_CREATED: "active",
  LISTING_CANCELLED: "cancelled",
  SALE: "active",
  SALE_CANCELLED: "cancelled",
  PURCHASE: "active",
  VOUCHER_REDEEMED: "sold_out",
  VOUCHER_CANCELLED: "cancelled",
};

function activityItemRow(item) {
  const sub = [item.project_name, item.seller_display_name].filter(Boolean).join(" · ");
  return `
    <div class="hc-comp">
      <div class="hc-comp-left">
        <div>${voucherNumberBadge(item.voucher_number)}</div>
        ${sub ? `<div class="hc-comp-project">${sub}</div>` : ""}
      </div>
      <div class="hc-comp-right">
        <span class="hc-comp-qty">${item.quantity} УЕ</span>
        <span class="hc-comp-price">${item.price.toFixed(2)} ₽</span>
      </div>
    </div>
  `;
}

function activityCard(e) {
  const css = ACTIVITY_TYPE_CSS[e.type] || "active";
  const label = ACTIVITY_TYPE_LABELS[e.type] || e.type;
  const qtyLine = e.quantity != null ? `${e.quantity} УЕ` : label;
  const amountLine = e.amount != null ? `${e.amount.toFixed(2)} ₽` : "";
  const sub = [e.project_name, e.counterparty_name].filter(Boolean).join(" · ");
  const hasItems = Array.isArray(e.items) && e.items.length > 0;

  const details = hasItems ? `
    <details class="hc-details">
      <summary>Показать вексели (${e.items.length})</summary>
      <div class="hc-comps">${e.items.map(activityItemRow).join("")}</div>
    </details>
  ` : "";

  return `
    <div class="history-card">
      <div class="hc-head">
        <div class="hc-info">
          <div class="hc-qty">${qtyLine}</div>
          <div class="hc-meta">
            <span class="status-pill status-pill--${css}" style="font-size:10.5px">${label}</span>
            ${sub ? `<span class="tag">${sub}</span>` : ""}
          </div>
        </div>
        <div class="hc-right">
          ${amountLine ? `<div class="hc-total">${amountLine}</div>` : ""}
          <div class="hc-date">${new Date(e.created_at).toLocaleString("ru-RU")}</div>
        </div>
      </div>
      ${details}
    </div>
  `;
}

async function loadHistory() {
  const container = document.getElementById("history-list");
  container.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  try {
    const events = await api("/users/me/activity");
    if (!events.length) { container.innerHTML = `<p class="empty-row">Активности пока нет — купите УЕ на витрине или выставьте своё объявление.</p>`; return; }
    container.innerHTML = events.map(activityCard).join("");
  } catch (err) { container.innerHTML = `<p class="empty-row">${err.message}</p>`; }
}

/* ============================================================
   ПРОФИЛЬ — денежный баланс и баланс УЕ в реестре
   ============================================================ */

async function loadProfile() {
  const container = document.getElementById("profile-content");
  container.innerHTML = `<p class="empty-row">Загружаю…</p>`;
  try {
    const p = await api("/users/me");
    const money = p.cash_balance.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = p.carbon_units_total.toLocaleString("ru-RU");
    const available = p.carbon_units_available.toLocaleString("ru-RU");
    const frozen = p.carbon_units_frozen.toLocaleString("ru-RU");

    container.innerHTML = `
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h3>Денежный баланс</h3></div>
          <div class="profile-figure">${money} ₽</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Углеродные единицы на балансе</h3></div>
          <div class="profile-figure">${total} УЕ</div>
          <div class="card-rows" style="margin-top:14px">
            <div class="card-row"><span>Доступно</span><b>${available} УЕ</b></div>
            <div class="card-row"><span>Заморожено под вексели</span><b>${frozen} УЕ</b></div>
          </div>
        </div>
      </div>
      <div class="panel" style="margin-top:20px">
        <div class="panel-head"><h3>Данные аккаунта</h3></div>
        <div class="card-rows">
          <div class="card-row"><span>Имя / организация</span><b>${p.display_name}</b></div>
          <div class="card-row"><span>Тип участника</span><b>${p.user_type === "LEGAL_ENTITY" ? "Юридическое лицо" : "Физическое лицо"}</b></div>
          <div class="card-row"><span>Email</span><b>${p.email}</b></div>
          ${p.inn ? `<div class="card-row"><span>ИНН</span><b>${p.inn}</b></div>` : ""}
          ${p.ogrn ? `<div class="card-row"><span>ОГРН</span><b>${p.ogrn}</b></div>` : ""}
        </div>
      </div>
    `;
  } catch (err) { container.innerHTML = `<p class="empty-row">${err.message}</p>`; }
}

/* ---------------------------- Инициализация ---------------------------- */

initAuthTabs();
refreshAuthUI();
loadListings();
