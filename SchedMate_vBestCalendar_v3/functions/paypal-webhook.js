export async function onRequest({ request, env }) {
  /* ================================
     READ RAW BODY (REQUIRED)
  ================================ */
  const rawBody = await request.text();
  const body = JSON.parse(rawBody);

  /* ================================
     VERIFY PAYPAL WEBHOOK SIGNATURE
  ================================ */
  const verifyRes = await fetch(
    "https://api-m.paypal.com/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`),
      },
      body: JSON.stringify({
        transmission_id: request.headers.get("paypal-transmission-id"),
        transmission_time: request.headers.get("paypal-transmission-time"),
        cert_url: request.headers.get("paypal-cert-url"),
        auth_algo: request.headers.get("paypal-auth-algo"),
        transmission_sig: request.headers.get("paypal-transmission-sig"),
        webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: body,
      }),
    }
  );

  const verifyData = await verifyRes.json();

  if (verifyData.verification_status !== "SUCCESS") {
    console.error("❌ PayPal webhook verification failed", verifyData);
    return new Response("Invalid PayPal webhook", { status: 400 });
  }

  /* ================================
     SUPABASE CONFIG
  ================================ */
  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  const eventType = body.event_type;
  const resource = body.resource;
  const subscriptionId = resource?.id;

  if (!subscriptionId) {
    console.warn("⚠️ No subscription id in webhook");
    return new Response("Missing subscription id", { status: 200 });
  }

  async function updateBilling(payload) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/billing?paypal_subscription_id=eq.${subscriptionId}`,
      {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      }
    );
  }

  /* ================================
     PAYPAL EVENTS → BILLING STATE
  ================================ */

  if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {
    await updateBilling({
      status: "active",
      plan: "pro",
      grace_until: null,
    });
  }

  if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
    await updateBilling({
      status: "cancelled",
      grace_until: new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000 // ✅ 3 days grace
      ).toISOString(),
    });
  }

  if (eventType === "BILLING.SUBSCRIPTION.SUSPENDED") {
    await updateBilling({
      status: "past_due",
      grace_until: new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000
      ).toISOString(),
    });
  }

  if (eventType === "BILLING.SUBSCRIPTION.EXPIRED") {
    await updateBilling({
      status: "expired",
      grace_until: null,
    });
  }

  if (eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
    await updateBilling({
      status: "past_due",
      grace_until: new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000
      ).toISOString(),
    });
  }

  return new Response("OK", { status: 200 });
}
