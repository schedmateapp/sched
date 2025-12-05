// =======================================
// SCHEDMATE AUTH — FINAL PRODUCTION ✅
// Signup via Supabase Auth ONLY
// Login via Supabase Auth
// =======================================

const supabase = window.supabaseClient;

document.addEventListener("DOMContentLoaded", () => {
  const signupForm = document.getElementById("signup-form");

  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const msg = document.getElementById("auth-message");
      msg.textContent = "Creating workspace…";

      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      const options = {
        data: {
          full_name: document.getElementById("full_name").value.trim(),
          business_name: document.getElementById("business_name").value.trim(),
          phone: document.getElementById("phone").value.trim(),
          address: document.getElementById("address").value.trim(),
          timezone:
            document.getElementById("timezone").value || "Asia/Manila"
        }
      };

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options
      });

      if (error) {
        msg.textContent = error.message;
        return;
      }

      msg.textContent = "✅ Account created! Please log in.";
      setTimeout(() => {
        window.location.href = "/auth/login.html";
      }, 1200);
    });
  }

  const loginForm = document.getElementById("login-form");

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const msg = document.getElementById("auth-message");
      msg.textContent = "Logging in…";

      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      const { error } =
        await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        msg.textContent = "Invalid credentials or email not confirmed.";
        return;
      }

      window.location.href = "/dashboard/index.html";
    });
  }
});
