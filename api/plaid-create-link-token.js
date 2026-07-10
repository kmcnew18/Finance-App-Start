// /api/plaid-create-link-token.js
//
// Creates a short-lived Plaid "link_token" that the browser uses to open
// the Plaid Link widget. This must run server-side because it needs
// PLAID_CLIENT_ID + PLAID_SECRET, which should never be shipped to the
// browser.
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
//   PLAID_REDIRECT_URI    (optional) your registered OAuth redirect URI,
//                         must exactly match an entry under Developers >
//                         API > Allowed redirect URIs in the Plaid
//                         Dashboard for the matching environment.

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { decryptToken } = require('../lib/crypto-helpers');

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

    // OAuth institutions (Chase, Bank of America, most large US banks)
    // require this — Plaid redirects the user to the bank's own login
    // page, then back here. Only takes effect once PLAID_REDIRECT_URI is
    // set AND that exact URL is registered as an allowed redirect URI in
    // the Plaid Dashboard; harmless to leave in place before then; if
    // unset, this is simply omitted and non-OAuth institutions are
    // unaffected either way.
    if (process.env.PLAID_REDIRECT_URI) {
      linkTokenParams.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }

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
      // Normal mode — starting a brand new connection. Different
      // institution types support wildly different products (a bank
      // doesn't support Investments; a brokerage like Robinhood doesn't
      // support Auth; a lender may not support Investments at all), so
      // the products we require depend on what kind of account the
      // person is actually trying to connect. The frontend sends this
      // via accountCategory based on which "Connect with Plaid" button
      // they clicked (bank / investments / debt).
      const accountCategory = req.body.accountCategory || 'bank';

      const PRODUCT_SETS = {
        bank: {
          products: [Products.Auth, Products.Transactions],
          optional_products: [Products.Liabilities],
        },
        investments: {
          products: [Products.Investments, Products.Transactions],
          optional_products: [],
        },
        debt: {
          products: [Products.Liabilities, Products.Transactions],
          optional_products: [],
        },
      };

      const chosen = PRODUCT_SETS[accountCategory] || PRODUCT_SETS.bank;
      linkTokenParams.products = chosen.products;
      linkTokenParams.optional_products = chosen.optional_products;
      linkTokenParams.transactions = { days_requested: 180 }; // Recurring Transactions wants 180+ days for good results
    }

    const response = await plaidClient.linkTokenCreate(linkTokenParams);

    res.status(200).json({ link_token: response.data.link_token });
  } catch (err) {
    const plaidError = err?.response?.data;
    console.error('plaid-create-link-token error:', plaidError || err);
    // Surfacing Plaid's actual error_code/error_message here (not just a
    // generic message) — none of this is sensitive, it's diagnostic
    // detail about the request itself, and without it this class of
    // error is unfixable from the browser alone.
    res.status(500).json({
      error: plaidError?.error_message || 'Could not create a Plaid link token',
      error_code: plaidError?.error_code || null,
      error_type: plaidError?.error_type || null,
    });
  }
};