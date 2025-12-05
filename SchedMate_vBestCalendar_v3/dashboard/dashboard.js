/* ============================================================
   SCHEDMATE — CRM PRO MAX
   Single-source dashboard logic
   - Supabase auth
   - Global clients + bookings
   - Overview KPIs
   - CRM list + fullscreen client modal
   - Timeline + booking history
   - Calendar (month + week)
   - Sidebar view switch
   - Billing lock + feature guard (plans)
============================================================ */

// GET SUPABASE FROM GLOBAL
const db = window.supabaseClient;

if (!db) {
  throw new Error("Supabase not initialized");
}

/* ================================
   GLOBAL STATE
================================ */
let currentUser = null;
let clients = [];
let bookings = [];
let bookingLogs = [];
let editingBooking = null;
let activeClientForBooking = null;
let editingClientId = null; // client edit mode
let bookingConfirmAction = null; // { id, type: "complete" | "cancel" }

// CALENDAR STATE
let calendarDate = new Date();          // controls visible month/week
let calendarMode = "month";             // "month" | "week"
let calendarRenderLock = false;         // prevent double render
let navLock = false;                    // prevent rapid prev/next spam

// BILLING / PLAN STATE
let billingStatus = "trial";  // "trial" | "active" | "cancelled" | "expired" | "past_due"
let userPlan = "starter";     // "starter" | "pro" | "owner"

/* ================================
   NAV LOCK HELPER
================================ */
function safeNav(fn) {
  if (navLock) return;
  navLock = true;
  requestAnimationFrame(() => {
    fn();
    navLock = false;
  });
}

/* ================================
   AUTH
================================ */
async function ensureUser() {
  const {
    data: { session },
    error,
  } = await db.auth.getSession();

  if (!session || error) {
    window.location.href = "/auth/login.html";
    return null;
  }

  currentUser = session.user;
  return currentUser;
}

/* ================================
   BILLING STATUS + LOCK
================================ */
function lockElement(el, reason = "Upgrade required") {
  if (!el) return;
  el.disabled = true;
  el.classList.add("locked");
  el.title = reason;
}

function hideElement(el) {
  if (!el) return;
  el.style.display = "none";
}

function requireUpgrade(actionName = "This feature") {
  alert(`${actionName} requires an active subscription.`);
  window.location.href = "/billing/manage";
}

function lockDashboard(message) {
  document.body.classList.add("billing-locked");

  document.querySelectorAll("button, input, select, textarea").forEach(el => {
    // do not lock sidebar nav
    if (el.closest("#sidebar")) return;
    if (el.closest("#calendar-root")) return;
    if (el.dataset.allowWhenLocked) return;
    el.disabled = true;
    el.classList.add("locked-disabled");
  });

  // links stay clickable (important for navigation)
  document.querySelectorAll("a").forEach(a => {
    if (a.closest("#sidebar")) return;
    if (!a.dataset.allowWhenLocked) {
      a.classList.add("locked-disabled");
    }
  });

  const modal = document.getElementById("upgrade-modal");
  const msg = document.getElementById("upgrade-msg");

  if (msg) {
    msg.textContent = message || "Subscription required.";
  }

  if (modal) modal.classList.remove("hidden");
}

// ONLY LOCK IF EXPIRED OR CANCELLED
async function loadBillingStatus() {
  if (userPlan === "owner") {
    billingStatus = "active";
    window.billingStatus = "active";
    window.billingGraceUntil = null;
    document.body.classList.remove("billing-locked");
    return;
  }

  const { data: { user } } = await db.auth.getUser();
  if (!user) return;

  const { data: billing, error } = await db
    .from("billing")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  // if local billingStatus still trial → do not lock yet
  if (billingStatus === "trial") {
    document.body.classList.remove("billing-locked");
  }

// HARD SAFETY — NO BILLING ROW = EXPIRED (RACE-SAFE)
if (!billing) {
  await db.from("billing").upsert({
    user_id: user.id,
    status: "expired",
    plan: "starter"
  }, {
    onConflict: "user_id"
  });

  billingStatus = "expired";
  window.billingStatus = "expired";

  lockDashboard("Your subscription has ended. Please upgrade.");
  return;
}

  // assign global
  billingStatus = billing.status;
  window.billingStatus = billing.status;
  window.billingGraceUntil = billing.grace_until || null;

  // AUTO-EXPIRE TRIAL
  if (
    billing.status === "trial" &&
    billing.trial_ends_at &&
    Date.now() > new Date(billing.trial_ends_at).getTime()
  ) {
    await db
      .from("billing")
      .update({ status: "expired" })
      .eq("user_id", user.id);

    billingStatus = "expired";
    window.billingStatus = "expired";
  }

  // TRIAL UI
  if (billingStatus === "trial") {
    showTrialBanner(billing.trial_ends_at);
    return;
  }

  // GRACE PERIOD (LIMITED ACCESS)
  if (
    ["cancelled", "past_due"].includes(billingStatus) &&
    billing.grace_until &&
    Date.now() < new Date(billing.grace_until).getTime()
  ) {
    showToast("⚠️ Payment issue. Grace period active.", "warning");
    return;
  }

  // HARD LOCK
  if (["expired", "cancelled", "past_due", "suspended"].includes(billingStatus)) {
    lockDashboard("Your subscription has ended. Please upgrade.");
  }
}

async function refreshBillingLive() {
  if (!currentUser) return;

  const { data: billing, error } = await db
    .from("billing")
    .select("status, grace_until")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error || !billing) return;

  billingStatus = billing.status;
  window.billingStatus = billing.status;
  window.billingGraceUntil = billing.grace_until || null;

  // AUTO-UNLOCK IF PAYMENT CONFIRMED
  if (billingStatus === "active") {
    document.body.classList.remove("billing-locked");

    const modal = document.getElementById("upgrade-modal");
    if (modal) modal.classList.add("hidden");

    showToast("✅ Subscription activated. Welcome to Pro!");
  }
}

/* ================================
   FEATURE GUARDS
================================ */
function showUpgradeModal(feature) {
  const msgEl = document.getElementById("upgrade-msg");
  if (msgEl) {
    msgEl.textContent = `You need an active subscription to use ${feature}.`;
  }

  const modal = document.getElementById("upgrade-modal");
  if (modal) {
    modal.classList.remove("hidden");
  }
}

/* ================================
   PLAN FEATURES
================================ */
const FEATURES = {
  starter: {
    timeline: false,
    editBooking: false,
    cancelBooking: false,
    addBooking: false,
    analytics: false,
  },
  pro: {
    timeline: true,
    editBooking: true,
    cancelBooking: true,
    addBooking: true,
    analytics: true,
  },
  owner: {
    timeline: true,
    editBooking: true,
    cancelBooking: true,
    addBooking: true,
    analytics: true,
  },
};

function can(feature) {
  // OWNER: bypass everything
  if (userPlan === "owner") return true;

  // Allow grace
  if (
    ["cancelled", "past_due"].includes(billingStatus) &&
    window.billingGraceUntil &&
    Date.now() < new Date(window.billingGraceUntil).getTime()
  ) {
    return FEATURES[userPlan]?.[feature] === true;
  }

  // Block expired
  if (billingStatus === "expired") return false;

  // Trial → use starter features
  if (billingStatus === "trial") {
    return FEATURES["starter"]?.[feature] === true;
  }

  return FEATURES[userPlan]?.[feature] === true;
}

async function loadUserPlan() {
  if (!currentUser) return;

  const { data, error } = await db
    .from("profiles")
    .select("plan")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.warn("loadUserPlan error:", error);
    return;
  }

  if (data?.plan) {
    userPlan = data.plan;
  } else {
    userPlan = "starter";
  }
}

/* ================================
   HELPERS
================================ */
function byId(id) {
  return document.getElementById(id);
}

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function setButtonLoading(btn, isLoading, text = "Saving…") {
  if (!btn) return;

  if (isLoading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    btn.classList.add("loading");
  } else {
    btn.textContent = btn.dataset.originalText || "Save";
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

function escapeHtml(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[&<>]/g, (c) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
    }[c]
  ));
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function formatTime12h(value) {
  if (!value) return "—";
  const [hStr, mStr = "00"] = String(value).split(":");
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return value;

  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;

  return `${h}:${mStr.padStart(2, "0")} ${ampm}`;
}

function getBookingDateObj(booking) {
  if (!booking.start_time) return null;
  const d = new Date(booking.start_time);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getBookingDateLabel(booking) {
  const d = getBookingDateObj(booking);
  if (!d) return "—";
  return d.toLocaleDateString();
}

function getBookingTimeLabel(booking) {
  const d = getBookingDateObj(booking);
  if (!d) return "—";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return formatTime12h(`${h}:${m}`);
}

function getBookingClientName(booking) {
  const client = clients.find(c => c.id === booking.client_id);
  return client?.full_name || "";
}

function statusChip(raw) {
  const s = (raw || "").toLowerCase();
  if (s === "completed") {
    return `<span class="chip chip-success">Completed</span>`;
  }
  if (s === "cancelled") {
    return `<span class="chip chip-muted">Cancelled</span>`;
  }
  if (s === "scheduled" || s === "pending") {
    return `<span class="chip chip-warning">Scheduled</span>`;
  }
  if (!s) {
    return `<span class="chip chip-muted">—</span>`;
  }
  return `<span class="chip chip-muted">${escapeHtml(raw)}</span>`;
}

function showTrialBanner(trialEndsAt) {
  if (billingStatus !== "trial") return;
  const banner = document.getElementById("trial-banner");
  const text = document.getElementById("trial-text");

  if (!banner || !text) return;

  // legacy accounts without trial_ends_at
  if (!trialEndsAt) {
    banner.classList.remove("hidden");
    text.textContent = "🎉 You are currently on a free trial.";
    return;
  }

  const now = Date.now();
  const end = new Date(trialEndsAt).getTime();
  if (isNaN(end)) return;

  const daysLeft = Math.ceil((end - now) / 86400000);
  if (daysLeft <= 0) return;

  text.textContent =
    daysLeft === 1
      ? "⏳ Your free trial ends tomorrow."
      : `⏳ You have ${daysLeft} days left in your free trial.`;

  banner.classList.remove("hidden");
}

/* ================================
   CALENDAR HELPERS
================================ */
function hasBookingCollision(bookingId, newStart, newEnd) {
  return bookings.some(b => {
    if (b.id === bookingId) return false;
    if (!b.start_time || !b.end_time) return false;

    const start = new Date(b.start_time);
    const end = new Date(b.end_time);

    // same day only
    if (start.toDateString() !== newStart.toDateString()) return false;

    // overlap check
    return newStart < end && newEnd > start;
  });
}
function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function groupOverlappingBookings(bookingsForDay) {
  const groups = [];

  bookingsForDay.forEach(b => {
    const start = new Date(b.start_time);
    const end = new Date(b.end_time);
    let placed = false;

    for (const group of groups) {
      if (
        group.some(g => {
          const gs = new Date(g.start_time);
          const ge = new Date(g.end_time);
          return start < ge && end > gs;
        })
      ) {
        group.push(b);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push([b]);
    }
  });

  return groups;
}
/* ================================
   CLIENT COLOR SYSTEM
================================ */
const CLIENT_COLORS = [
  "#4f8cff", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ec4899", // pink
  "#a855f7", // purple
  "#14b8a6", // teal
  "#ef4444", // red
];

function getClientColor(clientId) {
  if (!clientId) return "#9ca3af"; // gray fallback

  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = clientId.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % CLIENT_COLORS.length;
  return CLIENT_COLORS[index];
}

/* ============================================================
   CALENDAR — WEEKLY VIEW (PHASE 3)
============================================================ */
const CAL_ROW_HEIGHT = 30; // 30px ≈ 30 minutes
const CAL_START_HOUR = 6; // Week view starts at 6:00 AM

function renderWeeklyCalendar() {
  const grid = byId("cal-week-grid");
  const title = byId("cal-period-label");
  if (!grid || !title) return;

  grid.innerHTML = "";

  const start = startOfWeek(calendarDate);
  title.textContent =
    start.toLocaleDateString() +
    " – " +
    addDays(start, 6).toLocaleDateString();

  const hours = [];
  for (let h = 6; h <= 20; h++) hours.push(h);

  hours.forEach(hour => {
    const row = document.createElement("div");
    row.className = "week-row";

    row.innerHTML = `
      <div class="week-time">${formatTime12h(`${hour}:00`)}</div>
      ${[...Array(7)].map((_, i) => {
        const cellDate = addDays(start, i);
        const dateStr =
          cellDate.getFullYear() + "-" +
          String(cellDate.getMonth() + 1).padStart(2, "0") + "-" +
          String(cellDate.getDate()).padStart(2, "0");

        const slotBookings = bookings.filter(b => {
          if (!b.start_time) return false;
          const d = new Date(b.start_time);
         return (
  d.getHours() === hour &&
  d.getFullYear() === cellDate.getFullYear() &&
  d.getMonth() === cellDate.getMonth() &&
  d.getDate() === cellDate.getDate()
);
        });

        return `
          <div class="week-cell">
  ${(() => {
    const groups = groupOverlappingBookings(slotBookings);

    return groups.map(group => {
      const width = 100 / group.length;

      return group.map((b, i) => `
        <div class="week-booking"
             data-booking-id="${b.id}"
             style="
               background:${getClientColor(b.client_id)};
               width:${width}%;
               left:${i * width}%;
             ">
          <div class="resize-handle"></div>
          <div class="wk-client">${escapeHtml(getBookingClientName(b))}</div>
          <div class="wk-service">${escapeHtml(b.service || "")}</div>
        </div>
      `).join("");
    }).join("");
  })()}
</div>
        `;
      }).join("")}
    `;

    grid.appendChild(row);
  });

  // enable drag + resize after render
  setTimeout(enableWeeklyDrag, 0);
  setTimeout(enableWeeklyResize, 0);
}

/* ============================================================
   CALENDAR — DRAG / RESIZE BOOKINGS
============================================================ */
let draggingBooking = null;
let dragStartY = 0;
let dragGhost = null;

// RESIZE STATE
let resizingBooking = null;
let resizeStartY = 0;
let resizeStartHeight = 0;

function enableWeeklyDrag() {
  if (calendarMode !== "week") return;

  document.querySelectorAll(".week-booking").forEach(el => {
    if (el.dataset.dragBound) return;
    el.dataset.dragBound = "1";
    el.addEventListener("pointerdown", startDragBooking);
  });
}

function enableWeeklyResize() {
  document.querySelectorAll(".week-booking .resize-handle").forEach(handle => {
    handle.onpointerdown = startResizeBooking;
  });
}

function startResizeBooking(e) {
  if (draggingBooking) return;
  if (calendarMode !== "week") return;

  e.stopPropagation();
  e.preventDefault();

  resizingBooking = e.target.closest(".week-booking");
  resizingBooking.classList.add("resizing");

  resizeStartY = e.clientY;
  resizeStartHeight = resizingBooking.offsetHeight;

  document.addEventListener("pointermove", onResizeMove);
  document.addEventListener("pointerup", endResizeBooking, { once: true });
}

function onResizeMove(e) {
  if (!resizingBooking) return;

  const dy = e.clientY - resizeStartY;

  // 30-minute snap
  const snapped = Math.round((resizeStartHeight + dy) / CAL_ROW_HEIGHT) * CAL_ROW_HEIGHT;

  resizingBooking.style.height = Math.max(CAL_ROW_HEIGHT, snapped) + "px";
}

async function endResizeBooking() {
  if (!resizingBooking) return;

  resizingBooking.classList.remove("resizing");

  document.removeEventListener("pointermove", onResizeMove);

  const bookingId = resizingBooking.dataset.bookingId;
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) {
    resizingBooking = null;
    return;
  }

const start = new Date(booking.start_time);

// height → minutes
const totalMinutes =
  Math.round(resizingBooking.offsetHeight / CAL_ROW_HEIGHT) * 30;

const newEnd = new Date(start.getTime() + totalMinutes * 60000);

  if (hasBookingCollision(booking.id, start, newEnd)) {
  showToast("⚠️ Overlaps another booking", "warning");

  resizingBooking.style.height = "";
  resizingBooking = null;

  renderWeeklyCalendar();
  return;
}

  // SAVE
  const { error } = await db
    .from("bookings")
    .update({ end_time: newEnd.toISOString() })
    .eq("id", booking.id);

  if (!error) {
    booking.end_time = newEnd.toISOString();
    showToast("⏱️ Booking duration updated");
  } else {
    showToast("❌ Failed to resize booking", "error");
  }

resizingBooking.style.height = "";
resizingBooking = null;
renderWeeklyCalendar();
return;
}

function startDragBooking(e) {
  if (resizingBooking) return;
  if (calendarMode !== "week") return;
  e.stopPropagation();

  draggingBooking = e.currentTarget;
  draggingBooking.classList.add("dragging");
// ✅ CREATE GHOST PREVIEW
dragGhost = draggingBooking.cloneNode(true);
dragGhost.querySelectorAll(".resize-handle")
  .forEach(h => h.remove());
dragGhost.classList.add("drag-ghost");
dragGhost.style.pointerEvents = "none";
dragGhost.style.opacity = "0.35";
dragGhost.style.zIndex = "999";

draggingBooking.parentElement.appendChild(dragGhost);

  dragStartY = e.clientY;

  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", endDragBooking, { once: true });
}

function onDragMove(e) {
if (!draggingBooking) {
  dragGhost?.remove();
  dragGhost = null;
  return;
}
  const dy = e.clientY - dragStartY;
  const maxY =
    draggingBooking.parentElement.offsetHeight -
    draggingBooking.offsetHeight;

  const limitedY = Math.max(0, Math.min(dy, maxY));

  // move real booking
  draggingBooking.style.transform = `translateY(${limitedY}px)`;

  // move ghost
  if (dragGhost) {
    dragGhost.style.transform = `translateY(${limitedY}px)`;
  }
}
async function endDragBooking(e) {
  // ✅ CLEAN GHOST (CORRECT PLACE)
  if (dragGhost) {
    dragGhost.remove();
    dragGhost = null;
  }

  if (!draggingBooking) return;

  draggingBooking.classList.remove("dragging");
  draggingBooking.style.transform = "";

  document.removeEventListener("pointermove", onDragMove);

  const bookingId = draggingBooking.getAttribute("data-booking-id");
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) {
    draggingBooking = null;
    return;
  }

  const weekGrid = document.querySelector(".cal-week-grid");
  if (!weekGrid) {
    draggingBooking = null;
    return;
  }

  const gridRect = weekGrid.getBoundingClientRect();
const timeColWidth = 60; // must match .week-time column width (CSS)
const usableWidth = gridRect.width - timeColWidth;
const colWidth = usableWidth / 7;

let relX = e.clientX - gridRect.left - timeColWidth;
relX = Math.max(0, Math.min(usableWidth - 1, relX));

const relY = e.clientY - gridRect.top;
const dayIndex = Math.max(0, Math.min(6, Math.floor(relX / colWidth)));

// ✅ Vertical position → snapped minutes
const rawMinutes = Math.round(relY / CAL_ROW_HEIGHT) * 30;

// ✅ Clamp so hindi lalagpas sa business hours (6AM–8PM)
const MAX_MINUTES = (20 - CAL_START_HOUR) * 60;

const clampedMinutes = Math.max(
  0,
  Math.min(rawMinutes, MAX_MINUTES)
);

const hourOffset = Math.floor(clampedMinutes / 60);
const minutes = clampedMinutes % 60;

const targetStart = startOfWeek(calendarDate);
targetStart.setDate(targetStart.getDate() + dayIndex);
targetStart.setHours(
  CAL_START_HOUR + hourOffset,
  minutes,
  0,
  0
);

  const duration =
    new Date(booking.end_time).getTime() -
    new Date(booking.start_time).getTime();

  const newStart = targetStart;
  const newEnd = new Date(newStart.getTime() + duration);
  if (hasBookingCollision(booking.id, newStart, newEnd)) {
  showToast("⚠️ Time slot already occupied", "warning");

  draggingBooking.style.transform = "";
  draggingBooking = null;

  renderWeeklyCalendar();
  return;
}

  // SAVE TO DB
  const { error } = await db
    .from("bookings")
    .update({
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString()
    })
    .eq("id", booking.id);

  if (error) {
    showToast("❌ Failed to move booking", "error");
  } else {
    booking.start_time = newStart.toISOString();
    booking.end_time = newEnd.toISOString();

    renderWeeklyCalendar();
    showToast("✅ Booking moved");
  }

  draggingBooking = null;
}

/* ============================================================
   CALENDAR — DAY DETAILS (PHASE 2)
============================================================ */
function openCalendarDay(dateStr, dayBookings) {
  const modal = byId("calendar-day-modal");
  const title = byId("calendar-day-title");
  const sub = byId("calendar-day-sub");
  const list = byId("calendar-day-list");

  if (!modal || !list) return;

  modal.style.zIndex = "1300";
  if (title) title.textContent = "Bookings";
  if (sub) sub.textContent = new Date(dateStr).toDateString();

  if (!dayBookings.length) {
    list.innerHTML = "<p class='muted'>No bookings for this day.</p>";
  } else {
    list.innerHTML = dayBookings.map(b => `
      <div class="calendar-booking-card">
        <div class="calendar-booking-time">
          ${getBookingTimeLabel(b)}
        </div>
        <div class="calendar-booking-client">
          <span
            class="client-color-dot"
            style="background:${getClientColor(b.client_id)}"
          ></span>
          ${escapeHtml(getBookingClientName(b))}
        </div>
        <div class="calendar-booking-service">
          ${escapeHtml(b.service || "Service")}
        </div>
        <div class="calendar-booking-actions">
          <button class="btn-xs btn-secondary"
            onclick="
              document.getElementById('calendar-day-modal')?.classList.add('hidden');
              openEditBookingById('${b.id}');
            ">
            ✎ Edit
          </button>
        </div>
      </div>
    `).join("");
  }

  modal.classList.remove("hidden");
}

byId("close-calendar-day")?.addEventListener("click", () => {
  byId("calendar-day-modal")?.classList.add("hidden");
});

document
  .querySelector("#calendar-day-modal .modal-overlay")
  ?.addEventListener("click", () => {
    byId("calendar-day-modal")?.classList.add("hidden");
  });

/* ================================
   AVATAR UPLOAD (CLIENT PROFILE)
================================ */
function initAvatarUpload() {
  const avatarClick = byId("avatar-click");
  const avatarUpload = byId("avatar-upload");
  const avatarImg = byId("avatar-img");
  const avatarLetter = byId("avatar-letter");

  if (!avatarClick || !avatarUpload) return;

  avatarClick.onclick = () => avatarUpload.click();

  avatarUpload.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (avatarImg) {
        avatarImg.src = reader.result;
        avatarImg.classList.remove("hidden");
      }
      if (avatarLetter) {
        avatarLetter.classList.add("hidden");
      }
    };
    reader.readAsDataURL(file);
  };
}

/* ================================
   ADD CLIENT MODAL
================================ */
function closeAddClient() {
  const modal = document.getElementById("add-client-modal");
  if (modal) modal.classList.add("hidden");
}

function openAddClient() {
  const modal = document.getElementById("add-client-modal");
  if (!modal) return;

  editingClientId = null; // ADD MODE

  const header = document.querySelector("#add-client-modal h3");
  if (header) header.textContent = "Add Client";

  const saveBtn = document.getElementById("save-client-btn");
  if (saveBtn) saveBtn.textContent = "Save";

  byId("client-name").value = "";
  byId("client-phone").value = "";
  byId("client-email").value = "";
  byId("client-address").value = "";
  byId("client-notes").value = "";

  modal.classList.remove("hidden");
}

function openEditClient(clientId) {
  const client = clients.find(c => c.id === clientId);
  if (!client) {
    console.warn("Client not found:", clientId);
    return;
  }

  editingClientId = clientId;

  byId("client-name").value = client.full_name || "";
  byId("client-phone").value = client.phone || "";
  byId("client-email").value = client.email || "";
  byId("client-address").value = client.address || "";
  byId("client-notes").value = client.notes || "";

  const header = document.querySelector("#add-client-modal h3");
  if (header) header.textContent = "Edit Client";

  const saveBtn = document.getElementById("save-client-btn");
  if (saveBtn) saveBtn.textContent = "Save Changes";

  const modal = document.getElementById("add-client-modal");
  if (modal) modal.classList.remove("hidden");
}

/* ================================
   CALENDAR SWITCH UI
================================ */
function safeRenderCalendar() {
  if (calendarRenderLock) return;
  calendarRenderLock = true;

  requestAnimationFrame(() => {
    renderCalendar();
    calendarRenderLock = false;
  });
}

function setCalendarModeUI(mode) {
  const btnMonth = byId("cal-mode-month");
  const btnWeek = byId("cal-mode-week");

  if (!btnMonth || !btnWeek) return;

  btnMonth.classList.toggle("is-active", mode === "month");
  btnWeek.classList.toggle("is-active", mode === "week");
}

/* ================================
   CALENDAR SWITCH UI (V2 ✅)
================================ */
byId("cal-mode-month")?.addEventListener("click", () => {
  calendarMode = "month";

  byId("cal-month-view")?.classList.remove("is-hidden");
  byId("cal-week-view")?.classList.add("is-hidden");

  setCalendarModeUI("month");
  safeRenderCalendar();
});

byId("cal-mode-week")?.addEventListener("click", () => {
  calendarMode = "week";

  byId("cal-month-view")?.classList.add("is-hidden");
  byId("cal-week-view")?.classList.remove("is-hidden");

  setCalendarModeUI("week");
  renderWeeklyCalendar();
});

byId("close-add-client")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAddClient();
});

/* ================================
   UPGRADE MODAL
================================ */
function showUpgrade() {
  const modal = byId("upgrade-modal");
  if (modal) modal.classList.remove("hidden");
}

function closeUpgradeModal() {
  // do not allow dismiss if fully expired
  if (
    ["expired", "cancelled", "past_due"].includes(billingStatus) &&
    (
      !window.billingGraceUntil ||
      Date.now() > new Date(window.billingGraceUntil).getTime()
    )
  ) {
    lockDashboard("Your subscription has ended. Please upgrade.");
    return;
  }

  const modal = document.getElementById("upgrade-modal");
  if (!modal) return;

  modal.classList.add("hidden");
  document.body.classList.remove("billing-locked");
  window.__upgradeDismissed = true;
}

/* ================================
   BOOKING LOGS
================================ */
async function logBookingAction(bookingId, action, meta = {}) {
  const { data, error } = await db.auth.getUser();
  if (error || !data?.user) return;

  await db.from("booking_logs").insert({
    user_id: data.user.id,
    booking_id: bookingId,
    action,
    meta,
  });
}

/* ================================
   TIMELINE (DB TABLE: timeline)
================================ */
async function appendTimelineEntry(clientId, message, bookingId = null) {
  if (!clientId || !message) return;

  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data?.user) return;

    await db.from("timeline").insert({
      user_id: data.user.id,
      client_id: clientId,
      message,
      booking_id: bookingId,
    });
  } catch (err) {
    console.warn("appendTimelineEntry failed (safe to ignore for now):", err);
  }
}

async function loadTimeline(clientId) {
  const list = byId("timeline-list");
  if (!list) return;

  list.innerHTML = "<p class='empty-muted'>Loading activity…</p>";

  try {
    const { data, error } = await db
      .from("timeline")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!data || !data.length) {
      list.innerHTML = "<p class='empty-muted'>No activity yet.</p>";
      return;
    }

    list.innerHTML = data.map(item => `
      <div class="timeline-item" data-booking-id="${item.booking_id || ""}">
        <div class="timeline-meta">${formatDate(item.created_at)}</div>
        <div class="timeline-text">${escapeHtml(item.message || "")}</div>
      </div>
    `).join("");
  } catch (err) {
    console.warn("loadTimeline failed (safe to ignore for now):", err);
    list.innerHTML = "<p class='empty-muted'>Activity not available.</p>";
  }
}

/* ================================
   LOAD DATA
================================ */
async function loadClients() {
  if (!currentUser) return;

  const { data, error } = await db
    .from("clients")
    .select("*")
    .eq("owner_id", currentUser.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error loading clients", error);
    clients = [];
    return;
  }

  clients = data || [];
}

async function loadBookings() {
  if (!currentUser) return;

  const { data, error } = await db
    .from("bookings")
    .select("*")
    .eq("owner_id", currentUser.id);

  if (error) {
    console.error("Failed to load bookings", error);
    bookings = [];
  } else {
    bookings = data || [];
  }

  // Calendar refresh (SAFE)
  requestAnimationFrame(() => {
    if (!document.querySelector("#view-calendar")?.classList.contains("view-active")) {
      return;
    }

    if (calendarMode === "week") {
      renderWeeklyCalendar();
    } else {
      calendarMode = "month";
      safeRenderCalendar();
    }
  });
}

async function loadBookingLogs() {
  if (!currentUser) return;

  const { data, error } = await db
    .from("booking_logs")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading booking logs", error);
    bookingLogs = [];
    return;
  }

  bookingLogs = data || [];
}

/* ============================================================
   CRM LIST (CLIENTS VIEW)
============================================================ */
function renderClientsView() {
  const searchBox = byId("crm-search");
  const listBox = byId("crm-client-list");
  const emptyBox = byId("crm-empty");
  if (!listBox || !emptyBox) return;

  const query = searchBox?.value?.trim().toLowerCase() || "";

  const filtered = clients.filter(c => {
    return (
      !query ||
      (c.full_name || "").toLowerCase().includes(query) ||
      (c.phone || "").toLowerCase().includes(query) ||
      (c.email || "").toLowerCase().includes(query)
    );
  });

  listBox.innerHTML = "";

  if (!filtered.length) {
    emptyBox.classList.remove("hidden");
    return;
  }

  emptyBox.classList.add("hidden");

  filtered.forEach(client => {
    const card = document.createElement("div");
    card.className = "crm-client-row";
    card.dataset.id = client.id;

    card.innerHTML = `
      <div class="crm-client-name">
        ${escapeHtml(client.full_name || "Unnamed client")}
      </div>
      <div class="crm-client-contact">
        ${escapeHtml(client.phone || "—")}
      </div>
      <div class="crm-client-contact">
        ${escapeHtml(client.email || "—")}
      </div>
    `;

    card.addEventListener("click", () => {
      openClientProfile(client.id);
    });

    listBox.appendChild(card);
  });

  // CLIENT TAGS — COMING SOON
  document.querySelectorAll(".crm-tag").forEach(tag => {
    const type = tag.dataset.tag;
    if (type !== "all") {
      tag.classList.add("locked");
      tag.title = "Coming soon";
      tag.onclick = (e) => {
        e.preventDefault();
        showToast("🚧 This filter is coming soon", "warning");
      };
    }
  });
}

/* ============================================================
   CLIENT PROFILE MODAL (PRO MAX)
============================================================ */
function initClientModalClose() {
  const modal = byId("client-profile-modal");
  const closeBtn = byId("profile-close");

  if (!modal || !closeBtn) return;

  closeBtn.onclick = () => {
    modal.classList.add("hidden");
    modal.classList.remove("active");
  };

  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
      modal.classList.remove("active");
    }
  };
}

/* ================================
   TIMELINE ENGINE + PROFILE
================================ */
async function openClientProfile(clientId) {
  const client = clients.find((c) => c.id === clientId);
  if (!client) return;

  const modal = byId("client-profile-modal");
  if (!modal) return;

  // PROFILE NAME + AVATAR RESET
  const nameEl = byId("profile-name");
  const avatarLetter = byId("avatar-letter");
  const avatarImgEl = byId("avatar-img");

  if (nameEl) {
    nameEl.textContent = client.full_name || "";
  }

  if (avatarLetter) {
    avatarLetter.textContent =
      (client.full_name || "C").trim().charAt(0).toUpperCase();
    avatarLetter.classList.remove("hidden");
  }

  if (avatarImgEl) {
    avatarImgEl.classList.add("hidden");
  }

  // QUICK ACTION BUTTONS
  const callBtn = byId("qa-call");
  const smsBtn = byId("qa-sms");
  const emailBtn = byId("qa-email");
  const mapBtn = byId("qa-map");
  const addBookingBtn = byId("qa-add-booking");

  if (callBtn)
    callBtn.onclick = () =>
      client.phone && window.open(`tel:${client.phone}`);

  if (smsBtn)
    smsBtn.onclick = () =>
      client.phone && window.open(`sms:${client.phone}`);

  if (emailBtn)
    emailBtn.onclick =
      () => client.email && window.open(`mailto:${client.email}`);

  if (mapBtn)
    mapBtn.onclick = () =>
      client.address &&
      window.open(
        `https://maps.google.com/?q=${encodeURIComponent(client.address)}`
      );

  if (addBookingBtn) {
    addBookingBtn.onclick = () => {
      openAddBooking(client);
    };
  }

  // EDIT CLIENT
  const editBtn = byId("edit-client-btn");
  if (editBtn) {
    editBtn.onclick = () => {
      modal.classList.remove("active");
      modal.classList.add("hidden");
      editingClientId = clientId;
      openEditClient(clientId);
    };
  }

  // DELETE CLIENT
  const deleteBtn = byId("delete-client-btn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (
        !confirm(
          "⚠️ Delete this client and ALL their bookings? This cannot be undone."
        )
      ) {
        return;
      }

      await db.from("bookings").delete().eq("client_id", clientId);

      try {
        await db.from("timeline").delete().eq("client_id", clientId);
      } catch (e) {
        console.warn("Timeline table not found, skipped");
      }

      const { error } = await db.from("clients").delete().eq("id", clientId);
      if (error) {
        console.error(error);
        showToast("❌ Failed to delete client", "error");
        return;
      }

      clients = clients.filter((c) => c.id !== clientId);
      renderClientsView();

      modal.classList.add("hidden");
      modal.classList.remove("active");

      showToast("🗑️ Client deleted");
    };
  }

  // NOTES SAVE
  const notesBox = byId("profile-notes");
  const saveNotesBtn = byId("save-notes-btn");

  if (saveNotesBtn && notesBox) {
    notesBox.value = client.notes || "";

    saveNotesBtn.onclick = async () => {
      const newNotes = notesBox.value || "";
      const { error } = await db
        .from("clients")
        .update({ notes: newNotes })
        .eq("id", clientId);

      if (error) {
        console.error("Failed to save notes", error);
        alert("Failed to save notes. Please try again.");
        return;
      }

      const idx = clients.findIndex((c) => c.id === clientId);
      if (idx !== -1) clients[idx].notes = newNotes;

      await appendTimelineEntry(clientId, "Updated notes");
      await loadTimeline(clientId);
      showToast("✅ Notes saved");
    };
  }

  // LOAD TIMELINE + BOOKING HISTORY
  await loadTimeline(clientId);
  await loadClientBookingHistory(clientId);

  // SHOW MODAL
  modal.classList.remove("hidden");
  modal.classList.add("active");
}

/* ============================================================
   BOOKING HISTORY (CLIENT MODAL)
============================================================ */
async function loadClientBookingHistory(clientId) {
  const container = byId("profile-bookings");
  if (!container) return;

  container.innerHTML = "<p class='muted'>Loading bookings…</p>";

  const { data, error } = await db
    .from("bookings")
    .select("*")
    .eq("client_id", clientId)
    .order("start_time", { ascending: false });

  if (error) {
    console.error("Error loading client bookings", error);
    container.innerHTML =
      "<p class='error'>Failed to load booking history.</p>";
    return;
  }

  if (!data || !data.length) {
    container.innerHTML =
      "<p class='muted'>No bookings found for this client.</p>";
    return;
  }

  container.innerHTML = data
    .map(
      (b) => `
      <div class="booking-history-card">
        <div class="timeline-meta">
          ${getBookingDateLabel(b)} ${getBookingTimeLabel(b)}
        </div>
        <div class="timeline-service">
          ${escapeHtml(b.service || "Service")}
        </div>
        ${
          b.notes
            ? `<div class="timeline-notes">${escapeHtml(b.notes)}</div>`
            : ""
        }
        <div class="timeline-status">
          ${statusChip(b.status)}
        </div>
      </div>
    `
    )
    .join("");
}

/* =============================
   SIDEBAR COLLAPSE + TOOLTIPS
============================= */
function initSidebarCollapse() {
  const sidebar = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");

  if (!sidebar || !toggleBtn) return;

  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });
}

function initSidebarTooltips() {
  document.querySelectorAll(".nav-item").forEach(btn => {
    if (btn.querySelector(".tooltip")) return;

    const label =
      btn.querySelector(".text")?.textContent ||
      btn.dataset.tooltip;

    if (!label) return;

    const tip = document.createElement("span");
    tip.className = "tooltip";
    tip.textContent = label.trim();
    btn.appendChild(tip);
  });
}

/* ============================================================
   SIDEBAR NAVIGATION
============================================================ */
function changeView(view) {
  // HARD GUARD — timeline locked
  if (view === "timeline" && !can("timeline")) {
    showUpgrade();
    return;
  }

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  document.querySelectorAll(".view").forEach((section) => {
    const isActive = section.id === `view-${view}`;
    section.classList.toggle("view-active", isActive);
  });

  switch (view) {
    case "overview":
      renderOverview();
      break;

    case "clients":
      renderClientsView();
      break;

    case "bookings":
      renderBookingsView();
      break;

    case "services":
      renderServicesView();
      break;

    case "invoices":
      renderInvoicesView();
      break;

    case "payments":
      renderPaymentsView();
      break;

    case "analytics":
      renderAnalyticsView();
      break;

    case "settings":
      renderSettingsView();
      break;

    case "calendar":
      requestAnimationFrame(() => {
        if (calendarMode === "week") {
          byId("cal-month-view")?.classList.add("is-hidden");
          byId("cal-week-view")?.classList.remove("is-hidden");
          setCalendarModeUI("week");
          renderWeeklyCalendar();
        } else {
          calendarMode = "month";
          byId("cal-month-view")?.classList.remove("is-hidden");
          byId("cal-week-view")?.classList.add("is-hidden");
          setCalendarModeUI("month");
          safeRenderCalendar();
        }
      });
      break;
  }
}

function initSidebar() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "true";

    btn.addEventListener("click", () => {
      if (
        btn.classList.contains("locked") &&
        userPlan !== "owner"
      ) {
        showUpgrade();
        return;
      }

      const view = btn.dataset.view;
      if (!view) return;

      changeView(view);
    });
  });
}

/* ============================================================
   CALENDAR VIEW — MONTHLY
============================================================ */
function renderCalendar() {
  const grid = byId("cal-month-grid");
  const title = byId("cal-period-label");
  if (!grid || !title) return;

  grid.innerHTML = "";

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  title.textContent = calendarDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });

  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < startDay; i++) {
    const empty = document.createElement("div");
    empty.className = "calendar-cell empty";
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("div");
    cell.className = "calendar-cell";

    const dateStr =
      year +
      "-" +
      String(month + 1).padStart(2, "0") +
      "-" +
      String(day).padStart(2, "0");

    const dayBookings = bookings.filter(
      (b) => b.start_time && b.start_time.startsWith(dateStr)
    );

    const now = new Date();
    if (
      now.getFullYear() === year &&
      now.getMonth() === month &&
      now.getDate() === day
    ) {
      cell.classList.add("today");
    }

    const dayOfWeek = new Date(year, month, day).getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      cell.classList.add("weekend");
    }

    cell.innerHTML = `
      <div class="cal-day">${day}</div>
      ${
        dayBookings.length
          ? `
        <div class="cal-dot-wrapper">
          ${dayBookings
            .slice(0, 3)
            .map(
              (b) => `
                <span
                  class="cal-dot"
                  style="background:${getClientColor(b.client_id)}"
                  title="${escapeHtml(getBookingClientName(b))}"
                ></span>
              `
            )
            .join("")}
          ${
            dayBookings.length > 3
              ? `<span class="cal-dot more">+${dayBookings.length - 3}</span>`
              : ""
          }
        </div>
      `
          : ""
      }
    `;

    if (!dayBookings.length) {
      cell.insertAdjacentHTML(
        "beforeend",
        `<div class="cal-add-hint">＋</div>`
      );
    }

    cell.onclick = () => {
      if (dayBookings.length) {
        openCalendarDay(dateStr, dayBookings);
      } else {
        if (!can("addBooking")) {
          showUpgrade();
          return;
        }
        quickAddBookingFromCalendar(dateStr);
      }
    };

    grid.appendChild(cell);
  }
}

/* ============================================================
   OVERVIEW VIEW
============================================================ */
function renderOverview() {
  const box = byId("overview-content");
  if (!box) return;

  const now = new Date();
  const todayStr = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");

  const todaysBookings = bookings.filter(b =>
    b.start_time?.startsWith(todayStr) &&
    ["scheduled", "pending"].includes(
      (b.status || "").toLowerCase()
    )
  );

  const kpiToday = byId("kpi-today");
  const kpiClients = byId("kpi-clients");
  const kpiCompleted = byId("kpi-completed");

  if (kpiToday) kpiToday.textContent = todaysBookings.length;
  if (kpiClients) kpiClients.textContent = clients.length;

  const weekStart = startOfWeek(new Date());
  const weekEnd = addDays(weekStart, 7);

  const completedThisWeek = bookings.filter(b => {
    if (b.status !== "completed") return false;
    const d = getBookingDateObj(b);
    return d && d >= weekStart && d < weekEnd;
  }).length;
  if (kpiCompleted) kpiCompleted.textContent = completedThisWeek;

  box.innerHTML = `
    <div class="section-card">
      <h2>Today’s jobs</h2>
      <table class="table-shell">
        <thead>
          <tr>
            <th>Time</th>
            <th>Client</th>
            <th>Service</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${
            !todaysBookings.length
              ? `<tr><td colspan="4" class="text-muted">No jobs today.</td></tr>`
              : todaysBookings
                .map(
                  (b) => `
                    <tr>
                      <td>${getBookingTimeLabel(b)}</td>
                      <td>${escapeHtml(getBookingClientName(b))}</td>
                      <td>${escapeHtml(b.service || "")}</td>
                      <td>${statusChip(b.status)}</td>
                    </tr>
                  `
                )
                .join("")
          }
        </tbody>
      </table>
    </div>
  `;
}

/* ============================================================
   BOOKINGS VIEW
============================================================ */
function renderBookingsView() {
  const box = byId("view-bookings");
  if (!box) return;

  box.innerHTML = `
    <div class="section-header">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div>
          <h1 class="page-title">Bookings</h1>
          <p class="page-desc">Manage your job schedule.</p>
        </div>
        <button class="btn-primary" onclick="changeView('clients')">
          + Add Booking
        </button>
      </div>
    </div>

    <div class="section-card">
      <table class="table-shell">
        <thead>
          <tr>
            <th>Date</th>
            <th>Time</th>
            <th>Client</th>
            <th>Service</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${
            !bookings.length
              ? `<tr><td colspan="5" class="text-muted">No bookings yet.</td></tr>`
              : bookings
                .map(
                  (b) => `
                    <tr data-id="${b.id}">
                      <td>${getBookingDateLabel(b)}</td>
                      <td>${getBookingTimeLabel(b)}</td>
                      <td>${escapeHtml(getBookingClientName(b))}</td>
                      <td>${escapeHtml(b.service || "")}</td>
                      <td>
                        ${statusChip(b.status)}

                        ${
                          ["completed", "cancelled"].includes((b.status || "").toLowerCase())
                            ? ""
                            : `
<button
  class="btn-xs btn-secondary btn-edit-booking"
  data-booking-id="${b.id}">
  ✎ Edit
</button>
`
                        }

                        ${
                          bookingConfirmAction?.id === b.id
                            ? `
<button class="btn-xs btn-success"
  onclick="${
    bookingConfirmAction.type === "complete"
      ? `confirmBookingComplete('${b.id}')`
      : `confirmBookingCancel('${b.id}')`
  }">
  ✓ Confirm
</button>

<button class="btn-xs btn-muted"
  onclick="clearBookingConfirm()">
  ✕ Back
</button>
`
                            : ["pending", "scheduled"].includes((b.status || "").toLowerCase())
                              ? `
<button class="btn-xs btn-success"
  onclick="startBookingConfirm('${b.id}','complete')">
  ✓ Complete
</button>

<button class="btn-xs btn-danger"
  onclick="startBookingConfirm('${b.id}','cancel')">
  ✕ Cancel
</button>
`
                              : ""
                        }
                      </td>
                    </tr>
                  `
                )
                .join("")
          }
        </tbody>
      </table>
    </div>
  `;
}

/* ============================================================
   EMPTY SIDE VIEWS
============================================================ */
function renderServicesView() {
  const box = byId("view-services");
  if (!box) return;

  box.innerHTML = `
    <div class="empty-state">
      <h1>Services</h1>
      <p>Create and manage the services you offer.</p>

      <div class="empty-card">
        <p>No services yet.</p>
        <button class="btn-primary">+ Add Service</button>
      </div>
    </div>
  `;
}

function renderInvoicesView() {
  const box = byId("view-invoices");
  if (!box) return;

  box.innerHTML = `
    <div class="empty-state">
      <h1>Invoices</h1>
      <p>Invoices are generated from completed bookings.</p>

      <div class="empty-card">
        <p>No invoices yet.</p>
      </div>
    </div>
  `;
}

function renderPaymentsView() {
  const box = byId("view-payments");
  if (!box) return;

  box.innerHTML = `
    <div class="empty-state">
      <h1>Payments</h1>
      <p>Track customer payments and balances.</p>

      <div class="empty-card">
        <p>No payments recorded.</p>
      </div>
    </div>
  `;
}

function renderAnalyticsView() {
  const box = byId("view-analytics");
  if (!box) return;

  if (!can("analytics")) {
    box.innerHTML = `
      <div class="empty-state locked">
        <h1>Analytics</h1>
        <p>This feature is available on Pro plan.</p>
        <button class="btn-primary" onclick="showUpgrade()">Upgrade to Pro</button>
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div class="empty-state">
      <h1>Analytics</h1>
      <div class="empty-card">
        <p>📊 Charts & metrics coming soon.</p>
      </div>
    </div>
  `;
}

function renderSettingsView() {
  const box = byId("view-settings");
  if (!box || !currentUser) return;

  box.innerHTML = `
    <div class="section-card">
      <h2>Workspace settings</h2>
      <p>Account email: ${escapeHtml(currentUser.email || "")}</p>
    </div>
  `;
}

/* ============================================================
   BOOKING HELPERS
============================================================ */
async function refreshClientAfterBooking(clientId) {
  if (!clientId) return;

  await Promise.all([
    loadBookings(),
    loadBookingLogs(),
    loadClientBookingHistory(clientId),
    loadTimeline(clientId),
  ]);

  renderOverview();
  renderBookingsView();
  renderClientsView();
}

function startBookingConfirm(id, type) {
  bookingConfirmAction = { id, type };
  renderBookingsView();
}

function clearBookingConfirm() {
  bookingConfirmAction = null;
  renderBookingsView();
}

async function confirmBookingComplete(id) {
  bookingConfirmAction = null;
  await markBookingCompleted(id);
}

async function confirmBookingCancel(id) {
  bookingConfirmAction = null;
  await cancelBooking(id);
}

/* ============================================================
   EDIT BOOKING MODAL
============================================================ */
function openEditBookingById(id) {
  const booking = bookings.find(b => b.id === id);
  if (!booking) {
    showToast("Booking not found", "error");
    return;
  }
  openEditBooking(booking);
}

function closeEditBooking() {
  const editModal = byId("edit-booking-modal");
  const calendarModal = byId("calendar-day-modal");

  if (editModal) {
    editModal.classList.add("hidden");
    editModal.style.zIndex = "";
  }

  if (calendarModal && !calendarModal.classList.contains("hidden")) {
    calendarModal.style.zIndex = "";
  }

  editingBooking = null;

  byId("edit-booking-date").value = "";
  byId("edit-booking-time").value = "";
  byId("edit-booking-service").value = "";
  byId("edit-booking-status").value = "scheduled";
}

function logBookingEdit(oldBooking, newBooking) {
  const changes = [];

  if (oldBooking.start_time !== newBooking.start_time) {
    changes.push("date/time changed");
  }
  if (oldBooking.service !== newBooking.service) {
    changes.push("service changed");
  }
  if (oldBooking.status !== newBooking.status) {
    changes.push("status changed");
  }

  if (!changes.length) return;

  appendTimelineEntry(
    oldBooking.client_id,
    `Booking updated (${changes.join(", ")})`,
    oldBooking.id
  );
}

function openEditBooking(booking) {
  if (!booking || !booking.id) return;
  if (!can("editBooking")) {
    showUpgrade();
    return;
  }

  editingBooking = booking;

  const editModal = byId("edit-booking-modal");
  const calendarModal = byId("calendar-day-modal");

  if (calendarModal) {
    calendarModal.style.zIndex = "1200";
  }

  if (editModal) {
    editModal.style.zIndex = "1500";
  }

  const d = getBookingDateObj(booking);
  if (d) {
    byId("edit-booking-date").value = d.toISOString().split("T")[0];
    byId("edit-booking-time").value =
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0");
  }

  byId("edit-booking-service").value = booking.service || "";
  byId("edit-booking-status").value = booking.status || "";

  if (editModal) {
    editModal.classList.remove("hidden");
  }
}

// edit booking modal buttons
document
  .getElementById("close-edit-booking-alt")
  ?.addEventListener("click", closeEditBooking);
byId("close-edit-booking")?.addEventListener("click", closeEditBooking);

const editBookingModalEl = document.getElementById("edit-booking-modal");
if (editBookingModalEl) {
  editBookingModalEl.addEventListener("click", (e) => {
    if (e.target === editBookingModalEl) {
      closeEditBooking();
    }
  });
}

byId("save-edit-booking")?.addEventListener("click", async () => {
  if (!editingBooking) {
    showToast("⚠️ Booking session expired. Reopen booking.", "warning");
    return;
  }

  const dateVal = byId("edit-booking-date").value;
  const timeVal = byId("edit-booking-time").value;

  if (!dateVal || !timeVal) {
    showToast("Date and time required", "error");
    return;
  }

  const start = new Date(`${dateVal}T${timeVal}:00`);

 // KEEP ORIGINAL BOOKING DURATION
const originalDuration =
  new Date(editingBooking.end_time).getTime() -
  new Date(editingBooking.start_time).getTime();

const updated = {
  start_time: start.toISOString(),
  end_time: new Date(start.getTime() + originalDuration).toISOString(),
  service: byId("edit-booking-service").value,
  status: byId("edit-booking-status").value,
};

  const btn = byId("save-edit-booking");
  setButtonLoading(btn, true, "Saving…");

  const { error } = await db
    .from("bookings")
    .update(updated)
    .eq("id", editingBooking.id);

  if (error) {
    showToast("❌ Failed to update booking", "error");
    console.error(error);
    setButtonLoading(btn, false);
    return;
  }

  const oldCopy = { ...editingBooking };
  Object.assign(editingBooking, updated);

  if (calendarMode === "month") renderCalendar();
  if (calendarMode === "week") renderWeeklyCalendar();

  await logBookingAction(editingBooking.id, "edited", updated);
  logBookingEdit(oldCopy, editingBooking);

  showToast("✏️ Booking updated");

  const clientId = editingBooking.client_id;

  await refreshClientAfterBooking(clientId);
  renderOverview();
  setButtonLoading(btn, false);
});

/* ============================================================
   ADD BOOKING
============================================================ */
function closeAddBookingModal() {
  const bookingModal = byId("add-booking-modal");
  const profileModal = byId("client-profile-modal");

  if (bookingModal) {
    bookingModal.classList.add("hidden");
    bookingModal.style.zIndex = "";
  }

  if (profileModal) {
    profileModal.style.zIndex = "";
  }

  activeClientForBooking = null;
}

function openAddBooking(client) {
  if (!can("addBooking")) {
    showUpgrade();
    return;
  }

  const profileModal = byId("client-profile-modal");
  const bookingModal = byId("add-booking-modal");

  if (profileModal) {
    profileModal.style.zIndex = "1200";
  }

  const clientInput = byId("booking-client-name");

  if (client && client.id) {
    activeClientForBooking = client;
    if (clientInput) {
      clientInput.value = client.full_name;
    }
  } else {
    activeClientForBooking = null;
    if (clientInput) {
      clientInput.value = "← Select a client from the Clients tab";
    }
  }

  byId("booking-date").value = "";
  byId("booking-time").value = "";
  byId("booking-service").value = "";
  byId("booking-notes").value = "";

  if (bookingModal) {
    bookingModal.classList.remove("hidden");
    bookingModal.style.zIndex = "1400";
  }
}

function quickAddBookingFromCalendar(dateStr) {
  if (!can("addBooking")) {
    showUpgrade();
    return;
  }

  openAddBooking(null);

  const dateInput = byId("booking-date");
  if (dateInput) {
    dateInput.value = dateStr;
  }

  showToast("📅 Select client to finish booking", "info");
}

byId("closeAddBooking")?.addEventListener("click", closeAddBookingModal);
document
  .querySelector("#add-booking-modal .modal-overlay")
  ?.addEventListener("click", closeAddBookingModal);

byId("saveBookingBtn")?.addEventListener("click", async () => {
  const btn = byId("saveBookingBtn");
  setButtonLoading(btn, true);

  try {
    if (!activeClientForBooking) {
      showToast("Select a client first from Clients tab", "warning");
      setButtonLoading(btn, false);
      return;
    }

    if (!currentUser) return;

    const dateVal = byId("booking-date").value;
    const timeVal = byId("booking-time").value;
    if (!dateVal || !timeVal) {
      showToast("Date and time are required", "warning");
      setButtonLoading(btn, false);
      return;
    }

    const start = new Date(`${dateVal}T${timeVal}:00`);

    const payload = {
      owner_id: currentUser.id,
      client_id: activeClientForBooking.id,
      service: byId("booking-service").value || null,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      notes: byId("booking-notes").value || null,
      status: "scheduled"
    };

    const { data: newBooking, error } = await db
      .from("bookings")
      .insert(payload)
      .select()
      .single();

    if (error) {
      showToast("❌ Failed to save booking", "error");
      console.error(error);
      return;
    }

    bookings.push(newBooking);
    renderBookingsView();
    loadBookings();

    setTimeout(() => {
      const row = document.querySelector(`tr[data-id="${newBooking.id}"]`);
      if (!row) return;

      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("highlight-booking");

      setTimeout(() => row.classList.remove("highlight-booking"), 1500);
    }, 100);

    await appendTimelineEntry(
      activeClientForBooking.id,
      `New booking created (${byId("booking-service").value || "Service"})`,
      newBooking.id
    );

    await Promise.all([
      loadBookingLogs(),
      loadClientBookingHistory(activeClientForBooking.id),
      loadTimeline(activeClientForBooking.id),
    ]);

    showToast("✅ Booking created");
    closeAddBookingModal();

  } finally {
    setButtonLoading(btn, false);
  }
});

/* MARK COMPLETED / CANCEL */
async function markBookingCompleted(bookingId) {
  if (!can("editBooking")) {
    showUpgrade();
    return;
  }

  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) return;

  const { error } = await db
    .from("bookings")
    .update({ status: "completed" })
    .eq("id", bookingId);

  if (error) {
    console.error(error);
    alert("Failed to update booking");
    return;
  }

  booking.status = "completed";

  if (calendarMode === "month") renderCalendar();
  if (calendarMode === "week") renderWeeklyCalendar();

  await logBookingAction(booking.id, "completed");
  await appendTimelineEntry(
    booking.client_id,
    `Booking completed (${booking.service || "Service"})`,
    booking.id
  );

  await refreshClientAfterBooking(booking.client_id);
  if (
    document.querySelector("#view-bookings")?.classList.contains("view-active")
  ) {
    renderBookingsView();
  }

  showToast("✅ Booking marked as completed");
}

async function cancelBooking(bookingId) {
  if (!can("cancelBooking")) {
    showUpgrade();
    return;
  }

  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) return;

  const { error } = await db
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId);

  if (error) {
    console.error(error);
    alert("Failed to cancel booking");
    return;
  }

  booking.status = "cancelled";

  if (calendarMode === "month") renderCalendar();
  if (calendarMode === "week") renderWeeklyCalendar();

  await logBookingAction(booking.id, "cancelled");
  await appendTimelineEntry(
    booking.client_id,
    `Booking cancelled (${booking.service || "Service"})`,
    booking.id
  );

  await refreshClientAfterBooking(booking.client_id);
  if (
    document.querySelector("#view-bookings")?.classList.contains("view-active")
  ) {
    renderBookingsView();
  }

  showToast("❌ Booking cancelled", "error");
}

/* ============================================================
   TIMELINE CLICK → JUMP TO BOOKING
============================================================ */
function handleTimelineClick(e) {
  const container = document.getElementById("timeline-list");
  if (!container || !container.contains(e.target)) return;

  const item = e.target.closest(".timeline-item");
  if (!item) return;

  // do nothing if any booking modal is open
  if (
    document.getElementById("edit-booking-modal")?.classList.contains("hidden") === false ||
    document.getElementById("add-booking-modal")?.classList.contains("hidden") === false
  ) {
    return;
  }

  const bookingId = item.getAttribute("data-booking-id");
  if (!bookingId) return;

  changeView("bookings");

  setTimeout(() => {
    const row = document.querySelector(`tr[data-id="${bookingId}"]`);
    if (!row) return;

    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("highlight-booking");

    setTimeout(() => {
      row.classList.remove("highlight-booking");
    }, 1500);

    openEditBookingById(bookingId);
  }, 200);
}

if (document.body) {
  document.body.addEventListener("click", handleTimelineClick);
} else {
  window.addEventListener("DOMContentLoaded", () => {
    document.body.addEventListener("click", handleTimelineClick);
  });
}

/* ============================================================
   GLOBAL EVENTS
============================================================ */
// GLOBAL HANDLER — Edit Booking button
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-edit-booking");
  if (!btn) return;
  if (editingBooking) return;

  const id = btn.dataset.bookingId;
  if (!id) return;

  if (!can("editBooking")) {
    showUpgrade();
    return;
  }

  openEditBookingById(id);
});

// LOGOUT
byId("logout-btn")?.addEventListener("click", async () => {
  await db.auth.signOut();
  window.location.href = "/auth/login.html";
});

// UPGRADE MODAL BACKDROP
byId("upgrade-modal")?.addEventListener("click", (e) => {
  if (["expired", "cancelled"].includes(billingStatus)) return;
  if (e.target.id === "upgrade-modal") {
    closeUpgradeModal();
  }
});

// ADD CLIENT BUTTONS
document.querySelectorAll(".btn-new-client").forEach((btn) => {
  btn.addEventListener("click", openAddClient);
});

document.querySelectorAll(".btn-add-client").forEach((btn) => {
  btn.addEventListener("click", openAddClient);
});

document
  .querySelector("#add-client-modal")
  ?.addEventListener("click", (e) => {
    if (e.target.id === "add-client-modal") {
      closeAddClient();
    }
  });

async function saveClient() {
  if (!currentUser) {
    alert("Session expired. Please log in again.");
    return;
  }

  const payload = {
    full_name: document.getElementById("client-name").value.trim(),
    phone: document.getElementById("client-phone").value.trim(),
    email: document.getElementById("client-email").value.trim(),
    address: document.getElementById("client-address").value.trim(),
    notes: document.getElementById("client-notes").value.trim()
  };

  if (!payload.full_name) {
    alert("Client name is required");
    return;
  }

  let error;

  if (editingClientId) {
    ({ error } = await db
      .from("clients")
      .update(payload)
      .eq("id", editingClientId));

    if (!error) {
      const index = clients.findIndex(c => c.id === editingClientId);
      if (index !== -1) {
        clients[index] = { ...clients[index], ...payload };
      }
    }
  } else {
    payload.owner_id = currentUser.id;

    ({ error } = await db
      .from("clients")
      .insert(payload));
  }

  if (error) {
    console.error("Save client failed", error);
    alert("Failed to save client");
    return;
  }

  await loadClients();
  renderClientsView();

  if (editingClientId) {
    openClientProfile(editingClientId);
    showToast("✅ Client updated");
  } else {
    showToast("✅ Client added");
    changeView("clients");
  }

  closeAddClient();
  editingClientId = null;
}

const saveClientBtn = document.getElementById("save-client-btn");
if (saveClientBtn && !saveClientBtn.dataset.bound) {
  saveClientBtn.dataset.bound = "true";
  saveClientBtn.addEventListener("click", saveClient);
}

// GLOBAL ESC HANDLER — TOPMOST MODAL FIRST
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;

  const editModal = byId("edit-booking-modal");
  if (editModal && !editModal.classList.contains("hidden")) {
    closeEditBooking();
    return;
  }

  const calendarModal = byId("calendar-day-modal");
  if (calendarModal && !calendarModal.classList.contains("hidden")) {
    calendarModal.classList.add("hidden");
    return;
  }

  const addBookingModal = byId("add-booking-modal");
  if (addBookingModal && !addBookingModal.classList.contains("hidden")) {
    closeAddBookingModal();
    return;
  }

  const clientModal = byId("client-profile-modal");
  if (clientModal && !clientModal.classList.contains("hidden")) {
    clientModal.classList.add("hidden");
    clientModal.classList.remove("active");
    return;
  }
});

// Failsafe: recheck billing every 30 seconds
setInterval(() => {
  if (billingStatus !== "active") {
    refreshBillingLive();
  }
}, 30000);

function isOwner() {
  return userPlan === "owner";
}

/* ============================================================
   DASHBOARD INIT
============================================================ */
async function initDashboard() {
  await ensureUser();
  if (!currentUser) return;

  // 1. Load plan FIRST
  await loadUserPlan();

  document.querySelectorAll(".nav-item").forEach(btn => {
    const view = btn.dataset.view;
    if (view === "timeline" && !can("timeline")) {
      btn.classList.add("locked");
    }
    if (view === "analytics" && !can("analytics")) {
      btn.classList.add("locked");
    }
  });

  // 2. Load billing AFTER plan
  await loadBillingStatus();

  // 3. Load app data
  await Promise.all([
    loadClients(),
    loadBookings(),
    loadBookingLogs(),
  ]);

  // OWNER UI UNLOCK
  if (userPlan === "owner") {
    document.querySelectorAll(".nav-item.locked").forEach((el) => {
      el.classList.remove("locked");
      const lock = el.querySelector(".lock");
      if (lock) lock.remove();
    });
    document.getElementById("owner-badge")?.classList.remove("hidden");
  }

  await refreshBillingLive();
  initSidebar();
  initSidebarCollapse();
  initSidebarTooltips();
  initClientModalClose();
  initAvatarUpload();

  changeView("overview");
}

initDashboard().catch(err => {
  console.error("Dashboard init failed:", err);
});

// Calendar navigation — bind once
if (!window.__calendarNavBound) {
  window.__calendarNavBound = true;

  byId("cal-prev")?.addEventListener("click", () => {
    safeNav(() => {
      if (calendarMode === "week") {
        calendarDate.setDate(calendarDate.getDate() - 7);
        renderWeeklyCalendar();
      } else {
        calendarDate.setMonth(calendarDate.getMonth() - 1);
        safeRenderCalendar();
      }
    });
  });

  byId("cal-next")?.addEventListener("click", () => {
    safeNav(() => {
      if (calendarMode === "week") {
        calendarDate.setDate(calendarDate.getDate() + 7);
        renderWeeklyCalendar();
      } else {
        calendarDate.setMonth(calendarDate.getMonth() + 1);
        safeRenderCalendar();
      }
    });
  });
}