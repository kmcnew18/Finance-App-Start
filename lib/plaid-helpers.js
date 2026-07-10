// /lib/plaid-helpers.js
//
// Lives in /lib, not /api — Vercel counts every file directly inside
// /api as a separate Serverless Function, and the Hobby plan caps that
// at 12. This file isn't an endpoint itself (nothing calls it directly
// over HTTP), so keeping it outside /api avoids burning one of those 12
// slots on something that was never meant to be a route. Imported by
// the actual endpoint files via require('../lib/plaid-helpers').
//
// Requires: npm install plaid @supabase/supabase-js

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { decryptToken } = require('./crypto-helpers');

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
  let addedTransactions = [];
  let modifiedTransactions = [];
  let removedTransactions = [];
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
    });
    addedTransactions = addedTransactions.concat(resp.data.added);
    modifiedTransactions = modifiedTransactions.concat(resp.data.modified);
    removedTransactions = removedTransactions.concat(resp.data.removed);
    hasMore = resp.data.has_more;
    cursor = resp.data.next_cursor;
  }

  await supabaseAdmin
    .from('plaid_items')
    .update({ transactions_cursor: cursor })
    .eq('item_id', itemRow.item_id);

  return { addedTransactions, modifiedTransactions, removedTransactions };
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

// Persists every synced transaction (not just recurring or review-queued
// ones) — this is what the Spendings page reads to compute monthly
// category breakdowns. Also handles Plaid retracting a transaction
// (pending -> cancelled) by marking it removed rather than deleting it
// outright, so a month's totals don't silently shift after the fact
// without a record of why.
async function storeTransactions(userId, addedTransactions, modifiedTransactions = [], removedTransactions = []) {
  const rows = addedTransactions.map(txn => ({
    user_id: userId,
    plaid_transaction_id: txn.transaction_id,
    amount: txn.amount,
    txn_date: txn.date,
    merchant_name: txn.merchant_name || txn.name || null,
    plaid_category: txn.personal_finance_category?.primary || null,
  }));

  if (rows.length) {
    const { data: linkedAccounts } = await supabaseAdmin.from('linked_accounts').select('id, plaid_account_id').eq('user_id', userId);
    const accountIdByPlaidId = Object.fromEntries((linkedAccounts || []).map(a => [a.plaid_account_id, a.id]));
    addedTransactions.forEach((txn, i) => { rows[i].linked_account_id = accountIdByPlaidId[txn.account_id] || null; });

    await supabaseAdmin.from('transactions').upsert(rows, { onConflict: 'plaid_transaction_id' });
  }

  for (const txn of modifiedTransactions) {
    await supabaseAdmin.from('transactions').update({
      amount: txn.amount, txn_date: txn.date, merchant_name: txn.merchant_name || txn.name || null,
      plaid_category: txn.personal_finance_category?.primary || null,
    }).eq('plaid_transaction_id', txn.transaction_id);
  }

  for (const txn of removedTransactions) {
    await supabaseAdmin.from('transactions').update({ is_removed: true }).eq('plaid_transaction_id', txn.transaction_id);
  }
}

// For every newly-added transaction on an account that's mapped to
// exactly one Dashboard category at 100% (not split across several —
// attributing a fraction of one transaction to multiple categories isn't
// a guess worth making), queues a suggested Dashboard log entry: which
// category, add or subtract based on the sign of the amount, with
// Plaid's merchant name and category for context. Skips accounts with no
// mapping or a split mapping, and skips anything already queued.
async function queueDashboardReviews(userId, addedTransactions) {
  if (!addedTransactions.length) return 0;

  const { data: linkedAccounts } = await supabaseAdmin
    .from('linked_accounts')
    .select('id, plaid_account_id')
    .eq('user_id', userId);
  if (!linkedAccounts || !linkedAccounts.length) return 0;
  const linkedAccountByPlaidId = Object.fromEntries(linkedAccounts.map(a => [a.plaid_account_id, a.id]));

  const { data: splits } = await supabaseAdmin
    .from('account_category_splits')
    .select('*')
    .eq('user_id', userId);
  if (!splits || !splits.length) return 0;

  const singleCategoryByAccountId = {};
  linkedAccounts.forEach(a => {
    const accountSplits = splits.filter(s => s.linked_account_id === a.id);
    if (accountSplits.length === 1 && Number(accountSplits[0].split_percent) === 100) {
      singleCategoryByAccountId[a.id] = accountSplits[0].category_id;
    }
  });
  if (!Object.keys(singleCategoryByAccountId).length) return 0;

  const { data: categories } = await supabaseAdmin.from('budget_categories').select('id, name').eq('user_id', userId);
  const categoryNameById = Object.fromEntries((categories || []).map(c => [c.id, c.name]));

  // Dashboard's finance_log only has columns for the original four
  // categories — a custom category has nowhere to actually log a
  // transaction against yet. Suggesting one would be a dead end, so only
  // queue for accounts mapped to one of these.
  const LOGGABLE_NAMES = new Set(['savings', 'investment', 'expenses', 'checking']);

  let queuedCount = 0;

  for (const txn of addedTransactions) {
    // Plaid transfer-type transactions (moving money between the user's
    // own accounts) aren't real income/spending — suggesting those as
    // add/subtract would double-count against a transfer already
    // reflected in both accounts' balances. Skip them.
    if (txn.personal_finance_category?.primary === 'TRANSFER_IN' || txn.personal_finance_category?.primary === 'TRANSFER_OUT') continue;

    const linkedAccountId = linkedAccountByPlaidId[txn.account_id];
    if (!linkedAccountId) continue;
    const categoryId = singleCategoryByAccountId[linkedAccountId];
    if (!categoryId) continue;
    const categoryName = categoryNameById[categoryId];
    if (!categoryName || !LOGGABLE_NAMES.has(categoryName.toLowerCase())) continue;

    const { data: alreadyQueued } = await supabaseAdmin
      .from('pending_dashboard_reviews')
      .select('id')
      .eq('plaid_transaction_id', txn.transaction_id)
      .maybeSingle();
    if (alreadyQueued) continue;

    // Plaid's sign convention: positive = money left the account (a
    // spend), negative = money came in (a deposit).
    const suggestedAction = txn.amount > 0 ? 'subtract' : 'add';

    const { error: insertError } = await supabaseAdmin.from('pending_dashboard_reviews').insert({
      user_id: userId,
      plaid_transaction_id: txn.transaction_id,
      linked_account_id: linkedAccountId,
      category_id: categoryId,
      category_name: categoryNameById[categoryId] || null,
      suggested_action: suggestedAction,
      amount: Math.abs(txn.amount),
      txn_date: txn.date,
      merchant_name: txn.merchant_name || txn.name || null,
      plaid_category: txn.personal_finance_category?.primary || null,
    });
    if (!insertError) queuedCount++;
  }

  return queuedCount;
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
// queue reviews for anything newly matched to a mapped stream, and queue
// Dashboard suggestions for anything on a single-category-mapped account.
async function processItemUpdate(itemRow) {
  const { addedTransactions: rawAdded, modifiedTransactions, removedTransactions } = await syncTransactionsForItem(itemRow);

  // Only ever process transactions dated on or after the day this
  // connection was made — regardless of how Plaid's cursor/has_more
  // behaves (historical data can still arrive asynchronously after the
  // initial catch-up sync in plaid-exchange-token.js), a transaction
  // that happened before the account was connected should never show up
  // as something "new" here. This is the reliable guarantee; the
  // cursor catch-up is just an optimization on top of it.
  const connectedDate = itemRow.created_at ? itemRow.created_at.slice(0, 10) : null;
  const addedTransactions = connectedDate
    ? rawAdded.filter(t => t.date >= connectedDate)
    : rawAdded;

  const addedIds = addedTransactions.map(t => t.transaction_id);
  await storeTransactions(itemRow.user_id, addedTransactions, modifiedTransactions, removedTransactions);
  const streams = await refreshRecurringForItem(itemRow);
  const queuedCount = await matchAndQueueReviews(itemRow.user_id, streams, addedIds);
  const dashboardQueuedCount = await queueDashboardReviews(itemRow.user_id, addedTransactions);
  return { addedCount: addedIds.length, queuedCount, dashboardQueuedCount };
}

module.exports = {
  plaidClient,
  supabaseAdmin,
  mapAccountType,
  syncTransactionsForItem,
  storeTransactions,
  refreshRecurringForItem,
  matchAndQueueReviews,
  queueDashboardReviews,
  processItemUpdate,
};