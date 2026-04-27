require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Webhook route (MUST be before express.json()) ─────────────────────────
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️  Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("✅ Payment successful for:", session.metadata);

        // Fetch subscription period details from Stripe
        let periodStart = null;
        let periodEnd = null;
        if (session.subscription) {
          try {
            // Fetch period details AND set to cancel at period end (no auto-renewal)
            const stripeSub = await stripe.subscriptions.update(session.subscription, {
              cancel_at_period_end: true,
            });
            periodStart = new Date(stripeSub.current_period_start * 1000).toISOString();
            periodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();
            console.log("📅 Subscription set to cancel at period end:", periodEnd);
          } catch (e) {
            console.error("⚠️  Could not update subscription:", e.message);
          }
        }

        const now = new Date().toISOString();
        const insertData = {
          user_id: session.metadata.user_id,
          coach_id: session.metadata.coach_id,
          coach_plan_id: session.metadata.plan_uuid || null,
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          stripe_checkout_session_id: session.id,
          status: "active",
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: true,
          created_at: now,
          updated_at: now,
        };
        await supabase.from("subscriptions").insert(insertData);

        // Always record the payment in the payments table
        const paymentInsert = {
          user_id: session.metadata.user_id,
          coach_id: session.metadata.coach_id,
          coach_plan_id: session.metadata.plan_uuid || null,
          plan_name: session.metadata.plan_name || "Subscription",
          amount: session.amount_total ? Math.round(session.amount_total / 100) : 0,
          provider: "stripe",
          provider_payment_id: session.payment_intent || session.invoice || session.id,
          payment_status: "completed",
          currency: session.currency || "usd",
        };
        console.log("💳 Inserting payment record:", paymentInsert);
        const { data: payResult, error: payError } = await supabase.from("payments").insert(paymentInsert).select();
        if (payError) {
          console.error("❌ Payment insert FAILED:", payError);
        } else {
          console.log("✅ Payment insert SUCCESS:", payResult);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        console.log("🔄 Subscription updated:", sub.id, "→", sub.status);

        await supabase
          .from("subscriptions")
          .update({ status: sub.status, updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        console.log("❌ Subscription cancelled:", sub.id);

        await supabase
          .from("subscriptions")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json());

// ─── Route 1: Create Checkout Session ──────────────────────────────────────
app.post("/api/stripe/create-checkout-session", async (req, res) => {
  const { userId, coachId, planId, planName, priceAmount, planUuid } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${planName} — RealSein Companion` },
            unit_amount: Math.round(priceAmount * 100), // convert to cents
            recurring: {
              interval: planId === "wk" || planId === "weekly" ? "week" : "month",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        user_id: userId,
        coach_id: coachId,
        plan_id: planId,
        plan_uuid: planUuid || "",
        plan_name: planName || "",
      },
      success_url: `${process.env.FRONTEND_URL}/SubscriptionSuccess?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/ChoosePlan`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 2: Coach Stripe Connect Onboarding ─────────────────────────────
app.post("/api/stripe/connect-account", async (req, res) => {
  const { coachId, email } = req.body;

  try {
    // Create a Stripe Express connected account for the coach
    // check if already exists
    const { data } = await supabase
      .from("coach_profiles")
      .select("stripe_account_id")
      .eq("id", coachId)
      .single();

    let accountId = data?.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email,
        metadata: { coach_id: coachId },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      account: accountId,

      await supabase
        .from("coach_profiles")
        .update({ stripe_account_id: accountId })
        .eq("id", coachId);
    }

    // Generate an onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.FRONTEND_URL}/PayoutSetup`,
      return_url: `${process.env.FRONTEND_URL}/FinalReview`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error("❌ Connect account error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 3: Check Subscription Status ───────────────────────────────────
app.get("/api/subscription/status", async (req, res) => {
  const { userId, coachId } = req.query;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("coach_id", coachId)
    .eq("status", "active")
    .single();

  if (error || !data) {
    return res.json({ active: false });
  }

  res.json({ active: true, subscription: data });
});

// ─── Route 4: Coach Connect Dashboard Link ────────────────────────────────
app.post("/api/stripe/connect-dashboard", async (req, res) => {
  const { stripeAccountId } = req.body;

  try {
    const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
    res.json({ url: loginLink.url });
  } catch (err) {
    console.error("❌ Dashboard link error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 5: Check Stripe Account Status ─────────────────────────────
app.post("/api/stripe/account-status", async (req, res) => {
  const { coachId } = req.body;

  try {
    // 1. Get stripe_account_id from DB
    const { data, error } = await supabase
      .from("coach_profiles")
      .select("stripe_account_id")
      .eq("id", coachId)
      .single();

    if (error || !data?.stripe_account_id) {
      return res.status(400).json({ error: "Stripe account not found" });
    }

    // 2. Fetch from Stripe
    const account = await stripe.accounts.retrieve(data.stripe_account_id);

    res.json({
      payouts_enabled: account.payouts_enabled,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });

  } catch (err) {
    console.error("❌ Account status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Start Server ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
