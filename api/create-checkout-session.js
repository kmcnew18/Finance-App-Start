import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Same service-role pattern as the other backend functions (Plaid, etc.) —
// requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to already be set as
// env vars on this host. If those aren't set yet here specifically, this
// lookup will fail and trialExpired falls back to true (see below), which
// just means cancel goes to the paywall instead of Dashboard — not
// dangerous, just not the exact behavior you want until those vars exist.
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { userId, email } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'Missing userId or email' });

  try {
    // Cancelling out of Stripe should send you back to Dashboard — unless
    // the trial has genuinely run out, in which case back to the paywall
    // (the only page that should ever say "your trial has ended").
    const { data: billing } = await supabaseAdmin
      .from('user_billing')
      .select('trial_end')
      .eq('user_id', userId)
      .maybeSingle();
    const trialExpired = billing ? new Date(billing.trial_end) < new Date() : true;
    const cancelUrl = trialExpired
      ? `${req.headers.origin}/paywall.html?payment=cancelled`
      : `${req.headers.origin}/dashboard.html?payment=cancelled`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      allow_promotion_codes: true, // shows the promo code field on checkout
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Arko — Full Access' },
          unit_amount: 1000 // $10.00
        },
        quantity: 1
      }],
      metadata: { userId },
      success_url: `${req.headers.origin}/dashboard.html?payment=success`,
      cancel_url: cancelUrl
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
}