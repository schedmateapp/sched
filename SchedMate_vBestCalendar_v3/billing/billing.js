const supabase = window.supabaseClient;
let currentUser = null;

/* ================================
   LOAD CURRENT USER
================================ */
async function loadUser() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (!session || error) {
    window.location.href = "/auth/login.html";
    return null;
  }

  currentUser = session.user;
  return currentUser;
}

/* ================================
   RENDER STATUS
================================ */
function renderStatus(state, user) {
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const noteEl = document.getElementById("note");

  if (!statusEl || !metaEl || !noteEl) return;

  // ✅ STATUS PILL
  statusEl.innerHTML = `
    <div class="status-pill ${state.status}">
      <span class="dot"></span>${state.status}
    </div>
  `;

  // ✅ META INFO
  metaEl.innerHTML = `
    <div>
      <div class="meta-label">Status</div>
      <div class="meta-value">${state.status}</div>
    </div>
    <div>
      <div class="meta-label">Plan</div>
      <div class="meta-value">${state.status === "active" ? "Pro" : "Starter"}</div>
    </div>
    <div>
      <div class="meta-label">Email</div>
      <div class="meta-value">${user.email}</div>
    </div>
  `;

  // ✅ NOTE
  if (state.status === "active") {
    noteEl.textContent = "Your subscription is active.";
  } else if (state.status === "trial") {
    noteEl.textContent = "You are currently on a free 7-day trial.";
  } else {
    noteEl.textContent = "Your subscription has expired. Please upgrade to continue.";
  }
}

/* ================================
   INIT (SINGLE SOURCE)
================================ */
(async function init() {
  const user = await loadUser();
  if (!user) return;

  // 🔥 SINGLE SOURCE OF TRUTH
  const billingState = await getBillingState(supabase, user.id);

  renderStatus(billingState, user);
})();