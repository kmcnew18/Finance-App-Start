// /api/plaid-create-link-token.js
//
// Creates a short-lived Plaid "link_token" that the browser uses to open
// the Plaid Link widget. This must run server-side because it needs
// PLAID_CLIENT_ID + PLAID_SECRET, which should never be shipped to the
// browser.
//
// Deploy path: same place your existing /api/create-checkout-session.js
// (or .ts) lives — same platform, same conventions. If that file uses a
// different export style (e.g. `export default` instead of
// `module.exports`), match this file to it so your build doesn't choke on
// mixed module formats.
//
// Requires the "plaid" npm package:
//   npm install plaid
//
// Required environment variables (set these in your hosting provider's
// dashboard — Vercel/Netlify/etc. — never commit them to the repo):
//   PLAID_CLIENT_ID
//   PLAID_SECRET
//   PLAID_ENV            "sandbox" | "development" | "production"
//   PLAID_WEBHOOK_URL     the public URL of your deployed
//                         /api/plaid-webhook endpoint, e.g.
//                         "https://yourapp.com/api/plaid-webhook"
//                         Must be publicly reachable — Plaid calls it, your
//                         browser never does.

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { decryptToken } = require('./_crypto-helpers');

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { userId, itemId } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    const linkTokenParams = {
      user: { client_user_id: userId },
      client_name: 'Arko',
      webhook: process.env.PLAID_WEBHOOK_URL,
      country_codes: [CountryCode.Us],
      language: 'en',
    };

    if (itemId) {
      // Update Mode — reconnecting an existing, already-linked Item (e.g.
      // the user needs to re-authenticate after a bank password change).
      // Pass the existing access_token instead of products: Plaid already
      // knows what this Item is authorized for, and re-specifying
      // products here could trigger unwanted additional consent/billing.
      const { data: itemRow, error: itemError } = await supabaseAdmin
        .from('plaid_items')
        .select('access_token')
        .eq('item_id', itemId)
        .eq('user_id', userId) // scoped to the requesting user
        .maybeSingle();

      if (itemError || !itemRow) {
        res.status(404).json({ error: 'Could not find that connection' });
        return;
      }

      linkTokenParams.access_token = decryptToken(itemRow.access_token);
    } else {
      // Normal mode — starting a brand new connection.
      // Auth covers checking/savings/credit accounts (the standard baseline
      // product for depository connections). Investments is required for
      // brokerage/retirement account balances to come through at all.
      // Liabilities adds richer loan/credit card data (minimum payment, due
      // date, interest rate) beyond the raw balance. Transactions is
      // required before Recurring Transactions (bill/income detection) can
      // work at all — see /api/plaid-sync-recurring.js.
      linkTokenParams.products = [Products.Auth, Products.Investments, Products.Liabilities, Products.Transactions];
      linkTokenParams.transactions = { days_requested: 180 }; // Recurring Transactions wants 180+ days for good results
    }

    const response = await plaidClient.linkTokenCreate(linkTokenParams);

    res.status(200).json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('plaid-create-link-token error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not create a Plaid link token' });
  }
};
