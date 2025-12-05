export async function scheduled(event, env, ctx) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  // 1️⃣ Find users stuck in trial / past_due
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/billing?status=in.(trial,past_due,cancelled)`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );

  const rows = await res.json();
  if (!rows.length) return;

  for (const bill of rows) {

    // ✅ AUTO-EXPIRE TRIAL
    if (
      bill.status === "trial" &&
      bill.trial_ends_at &&
      Date.now() > new Date(bill.trial_ends_at).getTime()
    ) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/billing?id=eq.${bill.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "expired" }),
        }
      );
    }
  }
}
