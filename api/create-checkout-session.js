import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// All Stripe billing actions live in this one file (checkout,
// subscription status/cancel/resume, tier upgrades), routed by
// `action` — same consolidation pattern as plaid-item-actions.js.
// Serverless function count is capped on this hosting plan, so new
// billing behavior goes here rather than as a new file.

// Prices live here, not in the Stripe Dashboard — Checkout supports
// building a session from inline price_data, so there's no need to
// pre-create Products/Prices in Stripe for this to work. Tier 1 isn't
// listed since it's free and never reaches checkout.
const TIER_PRICING = {
  2: { name: 'Arko — Tier 2: Automation', monthly: 800, lifetime: 9500 },
  3: { name: 'Arko — Tier 3: Full', monthly: 1500, lifetime: 16500 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body;

  if (action === 'status' || action === 'cancel' || action === 'resume') {
    return handleManageSubscription(req, res);
  }
  if (action === 'upgrade') {
    return handleUpgrade(req, res);
  }
  return handleCheckout(req, res);
}

// ================= NEW PURCHASE CHECKOUT (default) =================
async function handleCheckout(req, res) {
  const { userId, email, tier, billingPeriod } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'Missing userId or email' });

  const tierNum = Number(tier);
  const pricing = TIER_PRICING[tierNum];
  if (!pricing) return res.status(400).json({ error: 'Invalid tier — must be 2 or 3' });
  if (billingPeriod !== 'monthly' && billingPeriod !== 'lifetime') {
    return res.status(400).json({ error: 'Invalid billingPeriod — must be "monthly" or "lifetime"' });
  }

  try {
    // Cancelling out of Stripe should send you back to Dashboard —
    // unless the trial has genuinely run out and there's no active
    // tier, in which case back to the paywall (the only page that
    // should ever say "your trial has ended").
    const { data: billing } = await supabaseAdmin
      .from('user_billing')
      .select('trial_end, tier')
      .eq('user_id', userId)
      .maybeSingle();
    const trialExpired = billing ? new Date(billing.trial_end) < new Date() : true;
    const hasNoAccess = trialExpired && (!billing || billing.tier <= 1);
    const cancelUrl = hasNoAccess
      ? `${req.headers.origin}/paywall.html?payment=cancelled`
      : `${req.headers.origin}/dashboard.html?payment=cancelled`;

    const isMonthly = billingPeriod === 'monthly';
    const amount = isMonthly ? pricing.monthly : pricing.lifetime;

    const session = await stripe.checkout.sessions.create({
      mode: isMonthly ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: pricing.name },
          unit_amount: amount,
          ...(isMonthly ? { recurring: { interval: 'month' } } : {}),
        },
        quantity: 1
      }],
      metadata: { userId, tier: String(tierNum), billingPeriod },
      ...(isMonthly ? { subscription_data: { metadata: { userId, tier: String(tierNum) } } } : {}),
      success_url: `${req.headers.origin}/dashboard.html?payment=success`,
      cancel_url: cancelUrl
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session (checkout) error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= MANAGE SUBSCRIPTION (status / cancel / resume) =================
async function handleManageSubscription(req, res) {
  const { userId, action } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const { data: billing, error: billingError } = await supabaseAdmin
      .from('user_billing')
      .select('tier, billing_period, stripe_subscription_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (billingError) throw billingError;

    if (!billing || billing.billing_period !== 'monthly' || !billing.stripe_subscription_id) {
      return res.status(200).json({ hasSubscription: false, tier: billing?.tier || 1, billingPeriod: billing?.billing_period || 'free' });
    }

    if (action === 'cancel') {
      const updated = await stripe.subscriptions.update(billing.stripe_subscription_id, { cancel_at_period_end: true });
      return res.status(200).json({
        hasSubscription: true, tier: billing.tier, billingPeriod: billing.billing_period,
        cancelAtPeriodEnd: updated.cancel_at_period_end, currentPeriodEnd: updated.current_period_end,
      });
    }

    if (action === 'resume') {
      const updated = await stripe.subscriptions.update(billing.stripe_subscription_id, { cancel_at_period_end: false });
      return res.status(200).json({
        hasSubscription: true, tier: billing.tier, billingPeriod: billing.billing_period,
        cancelAtPeriodEnd: updated.cancel_at_period_end, currentPeriodEnd: updated.current_period_end,
      });
    }

    const sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    return res.status(200).json({
      hasSubscription: true, tier: billing.tier, billingPeriod: billing.billing_period,
      cancelAtPeriodEnd: sub.cancel_at_period_end, currentPeriodEnd: sub.current_period_end,
    });
  } catch (err) {
    console.error('create-checkout-session (manage) error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= TIER UPGRADE (Tier 2 -> Tier 3, at the difference) =================
async function handleUpgrade(req, res) {
  const { userId, email } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'Missing userId or email' });

  try {
    const { data: billing, error: billingError } = await supabaseAdmin
      .from('user_billing')
      .select('tier, billing_period, stripe_subscription_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (billingError) throw billingError;

    if (!billing || billing.tier !== 2) {
      return res.status(400).json({ error: 'Upgrade pricing only applies when moving from Tier 2 to Tier 3.' });
    }

    // Monthly: modify the existing subscription in place. Stripe's
    // own proration engine credits the unused portion of Tier 2 and
    // charges the difference for the remaining days at the Tier 3
    // rate — computed precisely by Stripe, not approximated here.
    if (billing.billing_period === 'monthly') {
      if (!billing.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found to upgrade.' });

      const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
      const itemId = subscription.items.data[0].id;

      const updated = await stripe.subscriptions.update(billing.stripe_subscription_id, {
        items: [{
          id: itemId,
          price_data: {
            currency: 'usd',
            product_data: { name: TIER_PRICING[3].name },
            unit_amount: TIER_PRICING[3].monthly,
            recurring: { interval: 'month' },
          },
        }],
        proration_behavior: 'create_prorations',
        metadata: { userId, tier: '3' },
      });

      await supabaseAdmin.from('user_billing').update({ tier: 3, is_paid: true }).eq('user_id', userId);

      return res.status(200).json({
        upgraded: true,
        mode: 'prorated_subscription',
        message: 'Upgraded to Tier 3 — the prorated difference for the rest of this billing period was charged today, and it renews at the Tier 3 rate from your next billing date.',
      });
    }

    // Lifetime: a second one-time payment for exactly the price
    // difference ($165 - $95 = $70), not the full Tier 3 price again.
    if (billing.billing_period === 'lifetime') {
      const upgradeAmount = TIER_PRICING[3].lifetime - TIER_PRICING[2].lifetime;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'Arko — Upgrade to Tier 3 (Lifetime)', description: 'Credited for your existing Tier 2 Lifetime purchase' },
            unit_amount: upgradeAmount,
          },
          quantity: 1,
        }],
        metadata: { userId, tier: '3', billingPeriod: 'lifetime' },
        success_url: `${req.headers.origin}/dashboard.html?payment=success`,
        cancel_url: `${req.headers.origin}/dashboard.html?payment=cancelled`,
      });

      return res.status(200).json({ upgraded: false, mode: 'checkout', url: session.url });
    }

    return res.status(400).json({ error: 'Unrecognized billing period for upgrade.' });
  } catch (err) {
    console.error('create-checkout-session (upgrade) error:', err);
    res.status(500).json({ error: err.message });
  }
}