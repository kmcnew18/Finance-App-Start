import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { userId, email } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'Missing userId or email' });

  try {
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
      cancel_url: `${req.headers.origin}/paywall.html?payment=cancelled`
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
}