// /api/_plaid-helpers.js
//
// Shared logic between plaid-webhook.js (automatic, event-driven) and
// plaid-sync-recurring.js (manual "Refresh" button). Not an HTTP endpoint
// itself — just the pipeline both of those call into.
//
// Requires: npm install plaid @supabase/supabase-js

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
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

// Plaid account "subtype" -> Arko's account_type. Anything not listed here
// falls back to 'other' rather than guessing wrong. Shared between
// plaid-exchange-token.js (new connections) and plaid-add-new-accounts.js
// (accounts added later to an existing connection) so the mapping logic
// only lives in one place.
const SUBTYPE_MAP = {
  checking: 'checking',
  savings: 'savings',
  'credit card': 'credit_card',
  'money market': 'savings',
  cd: 'savings',
  '401k': 'investment',
  '403b': 'investment',
  ira: 'investment',
  brokerage: 'investment',
  mutual_fund: 'investment',
  student: 'loan',
  mortgage: 'loan',
  auto: 'loan',
  business: 'loan',
};

function mapAccountType(plaidType, plaidSubtype) {
  if (plaidSubtype && SUBTYPE_MAP[plaidSubtype]) return SUBTYPE_MAP[plaidSubtype];
  if (plaidType === 'depository') return 'checking';
  if (plaidType === 'credit') return 'credit_card';
  if (plaidType === 'loan') return 'loan';
  if (plaidType === 'investment') return 'investment';
  return 'other';
}

// Pulls every page of new/changed transactions for one item since its
// stored cursor, and saves the new cursor when done. Returns the list of
// newly-ADDED transaction ids (modified/removed aren't relevant to the
// review queue — only new transactions get queued for approval).
async function syncTransactionsForItem(itemRow) {
  const accessToken = decryptToken(itemRow.access_token);
  let cursor = itemRow.transactions_cursor || undefined;
  let addedIds = [];
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
    });
    addedIds = addedIds.concat(resp.data.added.map(t => t.transaction_id));
    hasMore = resp.data.has_more;
    cursor = resp.data.next_cursor;
  }

  await supabaseAdmin
    .from('plaid_items')
    .update({ transactions_cursor: cursor })
    .eq('item_id', itemRow.item_id);

  return addedIds;
}

// Refreshes recurring_streams for one item from /transactions/recurring/get.
// Existing rows keep whatever mapping/ignored state you've already set —
// this only updates Plaid's own fields (amount, last_date, status, etc).
async function refreshRecurringForItem(itemRow) {
  const resp = await plaidClient.transactionsRecurringGet({
    access_token: decryptToken(itemRow.access_token),
  });

  const streams = [
    ...(resp.data.inflow_streams || []).map(s => ({ ...s, direction: 'inflow' })),
    ...(resp.data.outflow_streams || []).map(s => ({ ...s, direction: 'outflow' })),
  ];

  for (const s of streams) {
    const { data: existing } = await supabaseAdmin
      .from('recurring_streams')
      .select('id')
      .eq('user_id', itemRow.user_id)
      .eq('stream_id', s.stream_id)
      .maybeSingle();

    const fields = {
      user_id: itemRow.user_id,
      plaid_item_id: itemRow.item_id,
      stream_id: s.stream_id,
      description: s.description || s.merchant_name || 'Recurring transaction',
      merchant_name: s.merchant_name || null,
      direction: s.direction,
      average_amount: s.average_amount?.amount ?? null,
      last_amount: s.last_amount?.amount ?? null,
      last_date: s.last_date || null,
      frequency: s.frequency || null,
      status: s.status || null,
      category: (s.personal_finance_category && s.personal_finance_category.primary) || null,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await supabaseAdmin.from('recurring_streams').update(fields).eq('id', existing.id);
    } else {
      await supabaseAdmin.from('recurring_streams').insert(fields);
    }
  }

  return streams;
}

// For every stream the user has actually mapped to a Bills/Income line
// (and not ignored), checks whether any of the newly-added transaction ids
// belong to that stream, and queues a pending review for each one that
// isn't already queued. Plaid's recurring stream objects include a
// transaction_ids array of the transactions that make up that stream —
// this is what we cross-reference against.
async function matchAndQueueReviews(userId, streams, addedTransactionIds) {
  if (!addedTransactionIds.length) return 0;

  const { data: mappedStreams } = await supabaseAdmin
    .from('recurring_streams')
    .select('*')
    .eq('user_id', userId)
    .not('mapped_cat', 'is', null)
    .eq('ignored', false);

  if (!mappedStreams || !mappedStreams.length) return 0;

  let queuedCount = 0;

  for (const mapped of mappedStreams) {
    const plaidStream = streams.find(s => s.stream_id === mapped.stream_id);
    if (!plaidStream || !Array.isArray(plaidStream.transaction_ids)) continue;

    const matchingIds = plaidStream.transaction_ids.filter(id => addedTransactionIds.includes(id));
    if (!matchingIds.length) continue;

    // Fetch full transaction details for the matches so we have an amount/date/merchant to show in the review queue.
    for (const txnId of matchingIds) {
      const { data: alreadyQueued } = await supabaseAdmin
        .from('pending_transaction_reviews')
        .select('id')
        .eq('plaid_transaction_id', txnId)
        .maybeSingle();
      if (alreadyQueued) continue;

      // Use the stream's last-known amount/date as a reasonable default —
      // fetching full transaction details per-id would need an extra
      // /transactions/get call; this keeps the pipeline simple and is
      // accurate enough for a review queue the user checks before approving.
      const { error: insertError } = await supabaseAdmin.from('pending_transaction_reviews').insert({
        user_id: userId,
        stream_id: mapped.stream_id,
        plaid_transaction_id: txnId,
        amount: Math.abs(mapped.last_amount || mapped.average_amount || 0),
        txn_date: mapped.last_date || new Date().toISOString().slice(0, 10),
        merchant_name: mapped.merchant_name || mapped.description,
        mapped_cat: mapped.mapped_cat,
        mapped_line_id: mapped.mapped_line_id,
        mapped_line_name: mapped.mapped_line_name,
      });
      if (!insertError) queuedCount++;
    }
  }

  return queuedCount;
}

// Full pipeline for one item: sync transactions, refresh recurring streams,
// queue reviews for anything newly matched to a mapped stream.
async function processItemUpdate(itemRow) {
  const addedIds = await syncTransactionsForItem(itemRow);
  const streams = await refreshRecurringForItem(itemRow);
  const queuedCount = await matchAndQueueReviews(itemRow.user_id, streams, addedIds);
  return { addedCount: addedIds.length, queuedCount };
}

module.exports = {
  plaidClient,
  supabaseAdmin,
  mapAccountType,
  syncTransactionsForItem,
  refreshRecurringForItem,
  matchAndQueueReviews,
  processItemUpdate,
};
