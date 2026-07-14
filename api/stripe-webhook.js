import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Fires for both lifetime (mode: 'payment') and the very first charge
  // of a monthly subscription (mode: 'subscription') — the metadata set
  // at checkout-session creation carries tier/billingPeriod through
  // either way, so this one handler covers both purchase paths.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const tier = Number(session.metadata?.tier);
    const billingPeriod = session.metadata?.billingPeriod;

    if (!userId || !tier) {
      console.error('checkout.session.completed missing userId/tier in metadata:', session.metadata);
      return res.status(200).json({ received: true });
    }

    const { error } = await supabaseAdmin
      .from('user_billing')
      .update({
        is_paid: true, // kept in sync for anything not yet migrated off the old binary flag
        tier,
        billing_period: billingPeriod,
        stripe_customer_id: session.customer,
        stripe_session_id: session.id,
        stripe_subscription_id: session.subscription || null,
      })
      .eq('user_id', userId);

    if (error) console.error('stripe-webhook checkout.session.completed update error:', error);
  }

  // A cancelled or payment-failed subscription drops the account back
  // to Tier 1 — free forever, not locked out entirely. Matched by
  // stripe_subscription_id rather than metadata on the deletion event
  // itself, since that's reliably present on every subscription
  // regardless of how it was cancelled (dashboard, API, dunning).
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const { error } = await supabaseAdmin
      .from('user_billing')
      .update({
        is_paid: false,
        tier: 1,
        billing_period: 'free',
        stripe_subscription_id: null,
      })
      .eq('stripe_subscription_id', subscription.id);

    if (error) console.error('stripe-webhook customer.subscription.deleted update error:', error);
  }

  res.status(200).json({ received: true });
}