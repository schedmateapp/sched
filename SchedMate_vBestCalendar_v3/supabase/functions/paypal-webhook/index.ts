// supabase/functions/paypal-webhook/index.ts

// Deno-based Supabase Edge Function
// Handles PayPal webhooks (Sandbox by default)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// PayPal credentials
const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")!;
const PAYPAL_SECRET = Deno.env.get("PAYPAL_SECRET")!;
const PAYPAL_WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID")!;

// 🔁 Use sandbox by default. For LIVE, change to api-m.paypal.com
const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Helpers
async function getPayPalAccessToken(): Promise<string> {
  const creds = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`);

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    console.error("PayPal token error:", await res.text());
    throw new Error("Failed to get PayPal access token");
  }

  const data = await res.json();
  return data.access_token as string;
}

async function verifyWebhookSignature(
  headers: Headers,
  body: string,
): Promise<boolean> {
  const accessToken = await getPayPalAccessToken();

  const transmissionId = headers.get("paypal-transmission-id");
  const timestamp = headers.get("paypal-transmission-time");
  const signature = headers.get("paypal-transmission-sig");
  const authAlgo = headers.get("paypal-auth-algo");
  const certUrl = headers.get("paypal-cert-url");

  if (
    !transmissionId || !timestamp || !signature ||
    !authAlgo || !certUrl
  ) {
    console.error("Missing PayPal webhook headers");
    return false;
  }

  const verifyBody = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: signature,
    transmission_time: timestamp,
    webhook_id: PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(body),
  };

  const res = await fetch(
    `${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(verifyBody),
    },
  );

  if (!res.ok) {
    console.error(
      "PayPal verify error:",
      res.status,
      await res.text(),
    );
    return false;
  }

  const data = await res.json();
  return data.verification_status === "SUCCESS";
}

// Main handler
serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const bodyText = await req.text();

  // 🔒 Verify signature
  let isValid = false;
  try {
    isValid = await verifyWebhookSignature(req.headers, bodyText);
  } catch (e) {
    console.error("Error verifying webhook:", e);
    return new Response("Verification error", { status: 500 });
  }

  if (!isValid) {
    console.warn("Invalid PayPal webhook signature");
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(bodyText);
  const eventType = event.event_type as string;
  const resource = event.resource || {};

  console.log("PayPal webhook:", eventType);

  // Most PayPal subscription events use resource.id as subscription ID
  const subscriptionId: string | undefined = resource.id;
  if (!subscriptionId) {
    console.warn("No subscription id in webhook resource");
    return new Response("No subscription id", { status: 200 });
  }

  // Find billing row by subscription_id
  const { data: billingRow, error: billingErr } = await supabase
    .from("billing")
    .select("id, user_id")
    .eq("subscription_id", subscriptionId)
    .maybeSingle();

  if (billingErr) {
    console.error("Supabase billing fetch error:", billingErr);
    return new Response("DB error", { status: 500 });
  }

  if (!billingRow) {
    console.warn("No billing row for subscription:", subscriptionId);
    // Still 200 so PayPal doesn't retry forever
    return new Response("No matching billing row", { status: 200 });
  }

  const userId = billingRow.user_id as string;

  // Helper to update billing + profile together
  async function setStatusAndPlan(
    status: string,
    plan: string | null,
    extraBilling: Record<string, unknown> = {},
  ) {
    const now = new Date().toISOString();

    const { error: updateBillingError } = await supabase
      .from("billing")
      .update({
        status,
        updated_at: now,
        ...extraBilling,
      })
      .eq("id", billingRow.id);

    if (updateBillingError) {
      console.error("Update billing error:", updateBillingError);
      return;
    }

    if (plan) {
      const { error: updateProfileError } = await supabase
        .from("profiles")
        .update({ plan })
        .eq("id", userId);

      if (updateProfileError) {
        console.error("Update profile error:", updateProfileError);
      }
    }
  }

  // Handle key events
  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED": {
      // Payment successful / subscription active
      await setStatusAndPlan("active", "pro", { trial_end: null });
      break;
    }

    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED": {
      // User cancelled or PayPal suspended → downgrade
      await setStatusAndPlan("cancelled", "starter", {
        cancelled_at: new Date().toISOString(),
      });
      break;
    }

    case "BILLING.SUBSCRIPTION.EXPIRED": {
      await setStatusAndPlan("expired", "starter");
      break;
    }

    // Optional: mark as past_due if payment fails
    case "PAYMENT.SALE.DENIED":
    case "PAYMENT.SALE.REFUNDED": {
      await setStatusAndPlan("past_due", null);
      break;
    }

    default:
      console.log("Unhandled PayPal event:", eventType);
  }

  return new Response("OK", { status: 200 });
});
