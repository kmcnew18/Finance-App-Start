import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Same service-role pattern as the other backend functions (Plaid, etc.) —
// requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to already be set as
// env vars on this host.
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Prices live here, not in the Stripe Dashboard — Checkout supports
// building a session from inline price_data, so there's no need to
// pre-create Products/Prices in Stripe for this to work. Changing a
// price later just means changing a number here, not touching Stripe
// at all. Tier 1 isn't listed since it's free and never reaches
// checkout.
const TIER_PRICING = {
  2: {
    name: 'Arko — Tier 2: Automation',
    monthly: 800,    // $8.00/mo
    lifetime: 9500,  // $95.00 one-time
  },
  3: {
    name: 'Arko — Tier 3: Full',
    monthly: 1500,   // $15.00/mo
    lifetime: 16500, // $165.00 one-time
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
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
      allow_promotion_codes: true, // shows the promo code field on checkout
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
      // Subscriptions need their own metadata too — the webhook events
      // that fire later for a subscription (renewal, cancellation)
      // come from the subscription object itself, not the checkout
      // session, so this is what lets those events find their way
      // back to the right user without a separate lookup table.
      ...(isMonthly ? { subscription_data: { metadata: { userId, tier: String(tierNum) } } } : {}),
      success_url: `${req.headers.origin}/dashboard.html?payment=success`,
      cancel_url: cancelUrl
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
}