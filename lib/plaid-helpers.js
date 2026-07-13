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

// Checks whether most of this merchant's charges in our own stored
// transaction history get reversed by a matching refund within a few
// days — the signature of a temporary hold or verification charge, not
// a genuine subscription. This is a heuristic, not a certainty: a
// merchant with only one or two occurrences on record yet doesn't have
// enough history to judge either way, so it's left alone (returns
// false) rather than guessing from too little data.
async function isLikelyReimbursedPattern(userId, stream) {
  const merchantName = stream.merchant_name || stream.description;
  let txns = null;

  // Plaid's own stream object lists exactly which transactions it
  // matched into this pattern — using that directly is far more
  // precise than guessing from a merchant-name text match, which can
  // miss real matches or accidentally group unrelated charges that
  // happen to share a name.
  if (Array.isArray(stream.transaction_ids) && stream.transaction_ids.length) {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('txn_date, amount')
      .eq('user_id', userId)
      .in('plaid_transaction_id', stream.transaction_ids)
      .order('txn_date', { ascending: true });
    txns = data;
  }

  // Fall back to a merchant-name match only if Plaid didn't give us
  // transaction_ids to work with, or none of them were found in our
  // own stored history (e.g. they predate our storage window).
  if ((!txns || !txns.length) && merchantName) {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('txn_date, amount')
      .eq('user_id', userId)
      .eq('merchant_name', merchantName)
      .order('txn_date', { ascending: true });
    txns = data;
  }

  if (!txns || txns.length < 2) return false; // too little history to judge reliably

  const charges = txns.filter(t => Number(t.amount) > 0);
  if (!charges.length) return false;

  let reversedCount = 0;
  charges.forEach(charge => {
    const chargeAmt = Number(charge.amount);
    const chargeDate = new Date(charge.txn_date);
    const hasMatchingRefund = txns.some(t => {
      if (t === charge) return false;
      const amt = Number(t.amount);
      if (Math.abs(amt + chargeAmt) > 0.01) return false; // not the opposite amount
      const daysApart = (new Date(t.txn_date) - chargeDate) / 86400000;
      return daysApart >= 0 && daysApart <= 5;
    });
    if (hasMatchingRefund) reversedCount++;
  });

  return (reversedCount / charges.length) >= 0.5; // majority reversed
}

// Refreshes recurring_streams for one item from /transactions/recurring/get.
// Existing rows keep whatever mapping/ignored state you've already set —
// this only updates Plaid's own fields (amount, last_date, status, etc).
async function refreshRecurringForItem(itemRow) {
  // Scoped to only the accounts still actually linked under this item —
  // without this, Plaid happily returns streams for every account ever
  // seen on this access token, including ones removed from a
  // multi-account connection (e.g. checking stays connected but savings
  // was individually removed) or an item that's fully orphaned but
  // hasn't been cleaned up yet. Passing account_ids stops that at the
  // source instead of trying to filter it out after the fact.
  const { data: currentLinkedAccounts } = await supabaseAdmin
    .from('linked_accounts')
    .select('plaid_account_id')
    .eq('user_id', itemRow.user_id)
    .eq('plaid_item_id', itemRow.item_id);
  const currentAccountIds = (currentLinkedAccounts || []).map(a => a.plaid_account_id).filter(Boolean);
  if (!currentAccountIds.length) return []; // nothing currently linked under this item — nothing to refresh

  const resp = await plaidClient.transactionsRecurringGet({
    access_token: decryptToken(itemRow.access_token),
    account_ids: currentAccountIds,
  });

  const streams = [
    ...(resp.data.inflow_streams || []).map(s => ({ ...s, direction: 'inflow' })),
    ...(resp.data.outflow_streams || []).map(s => ({ ...s, direction: 'outflow' })),
  ];

  const seenStreamIds = [];

  for (const s of streams) {
    const { data: existing } = await supabaseAdmin
      .from('recurring_streams')
      .select('id')
      .eq('user_id', itemRow.user_id)
      .eq('stream_id', s.stream_id)
      .maybeSingle();

    // Plaid itself marks a stream TOMBSTONED once it no longer considers
    // it an active recurring pattern (e.g. a subscription that's been
    // cancelled) — it stays in the response for historical reference
    // rather than disappearing outright, so that status has to be read
    // explicitly rather than inferred from the stream's mere presence.
    const isTombstoned = s.status === 'TOMBSTONED';
    // Plaid's own detection runs against the full transaction history at
    // its end — there's no way to stop it from noticing a pattern in the
    // first place. What's checkable on our side is whether the charges
    // behind this "subscription" are actually just temporary holds —
    // things like card verification charges that get reversed by a
    // matching refund within a few days, which can look exactly like a
    // small recurring charge to a pattern-matcher even though it isn't
    // one. If most of a stream's occurrences show that shape, it's noise
    // worth hiding rather than a real subscription.
    const isReimbursedPattern = !isTombstoned && await isLikelyReimbursedPattern(itemRow.user_id, s);
    seenStreamIds.push(s.stream_id);

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
    // Only overwrite `ignored` in the hiding direction — never silently
    // un-ignore something the user deliberately hid, but do hide
    // anything Plaid now says is no longer active, or that looks like
    // reversed holds rather than a genuine subscription. A stream
    // that's simply still active and looks legitimate shouldn't have
    // this field touched either way.
    if (isTombstoned || isReimbursedPattern) fields.ignored = true;

    if (existing) {
      await supabaseAdmin.from('recurring_streams').update(fields).eq('id', existing.id);
    } else {
      await supabaseAdmin.from('recurring_streams').insert(fields);
    }
  }

  // Anything previously detected for this item that Plaid didn't return
  // at all this time — not even as tombstoned — is no longer a
  // recognized pattern; hide it the same way, so Spendings' subscription
  // list only ever reflects what's genuinely still current.
  const { data: staleStreams } = await supabaseAdmin
    .from('recurring_streams')
    .select('id, stream_id')
    .eq('user_id', itemRow.user_id)
    .eq('plaid_item_id', itemRow.item_id)
    .eq('ignored', false);
  const staleIds = (staleStreams || [])
    .filter(row => !seenStreamIds.includes(row.stream_id))
    .map(row => row.id);
  if (staleIds.length) {
    await supabaseAdmin.from('recurring_streams').update({ ignored: true }).in('id', staleIds);
  }

  return streams;
}

// Persists every synced transaction (not just recurring or review-queued
// ones) — this is what the Spendings page reads to compute monthly
// category breakdowns. Also handles Plaid retracting a transaction
// (pending -> cancelled) by marking it removed rather than deleting it
// outright, so a month's totals don't silently shift after the fact
// without a record of why.
// Classifies a Plaid transaction as expense / income / transfer.
// Transfers are money moving between two accounts you own (most
// commonly: paying a credit card bill from checking) — the actual
// spending already happened, with its real category, when the card was
// charged. Counting the bill payment too would double the same purchase.
// Plaid's own categorization already tags the large majority of these
// correctly (TRANSFER_IN/TRANSFER_OUT broadly, plus the specific
// LOAN_PAYMENTS_CREDIT_CARD_PAYMENT detail for card bill payments) —
// this defers to that rather than re-inventing detection heuristics.
function classifyTxnType(txn) {
  const primary = txn.personal_finance_category?.primary;
  const detailed = txn.personal_finance_category?.detailed;
  if (primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT') return 'transfer';
  if (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'transfer';
  return txn.amount > 0 ? 'expense' : 'income'; // Plaid convention: positive = spend, negative = deposit
}

// Specifically a credit card bill payment, not a general self-transfer.
// Both are classified as txn_type = 'transfer' above (correctly excluded
// from spend totals either way) — but they get different treatment in
// the Dashboard review queue: a checking->savings transfer is a real
// choice worth logging, while a card payment is just debt that was
// already accounted for the moment the original purchase happened.
// Suggesting a review for the payment itself would just be noise, not a
// decision the user actually needs to make.
function isCreditCardPayment(txn) {
  return txn.personal_finance_category?.detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';
}

async function storeTransactions(userId, addedTransactions, modifiedTransactions = [], removedTransactions = []) {
  const { data: linkedAccounts } = await supabaseAdmin.from('linked_accounts').select('id, plaid_account_id').eq('user_id', userId);
  const accountIdByPlaidId = Object.fromEntries((linkedAccounts || []).map(a => [a.plaid_account_id, a.id]));

  if (addedTransactions.length) {
    const rows = await Promise.all(addedTransactions.map(async txn => {
      const linkedAccountId = accountIdByPlaidId[txn.account_id] || null;
      return {
        user_id: userId,
        plaid_transaction_id: txn.transaction_id,
        amount: txn.amount,
        txn_date: txn.date,
        merchant_name: txn.merchant_name || txn.name || null,
        plaid_category: txn.personal_finance_category?.primary || null,
        plaid_detailed_category: txn.personal_finance_category?.detailed || null,
        txn_type: linkedAccountId ? await classifyTxnTypeVerified(userId, txn, linkedAccountId) : classifyTxnType(txn),
        is_pending: !!txn.pending,
        linked_account_id: linkedAccountId,
      };
    }));

    await supabaseAdmin.from('transactions').upsert(rows, { onConflict: 'plaid_transaction_id' });
  }

  for (const txn of modifiedTransactions) {
    const linkedAccountId = accountIdByPlaidId[txn.account_id] || null;
    await supabaseAdmin.from('transactions').update({
      amount: txn.amount, txn_date: txn.date, merchant_name: txn.merchant_name || txn.name || null,
      plaid_category: txn.personal_finance_category?.primary || null,
      plaid_detailed_category: txn.personal_finance_category?.detailed || null,
      txn_type: linkedAccountId ? await classifyTxnTypeVerified(userId, txn, linkedAccountId) : classifyTxnType(txn),
      is_pending: !!txn.pending,
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
// Plaid's TRANSFER_IN/TRANSFER_OUT category is broader than "moved
// between two of the user's own connected accounts" — it also covers
// P2P payments (Venmo, Zelle, PayPal) to or from other people, wire
// transfers, and other money movement that Plaid's model considers
// "transfer-shaped" without it actually being a self-transfer. Calling
// all of that a transfer meant real deposits — someone paying the user
// back, a P2P cashout — were getting excluded from spend/income totals
// and mislabeled, when they should just read as a normal deposit.
// This checks for what actually makes something a genuine self-
// transfer: a matching transaction, opposite sign, roughly the same
// amount, within a couple days, sitting on a *different* one of the
// user's own connected accounts. Without that match, it's treated as
// an ordinary deposit/withdrawal instead — erring toward "add," per
// updated direction, rather than assuming transfer by default.
// The original cross-account check here required BOTH sides of a
// transfer to be visible as connected accounts within Arko — but
// plenty of genuine self-transfers only have one visible side: a
// savings account at a different bank that isn't connected, a
// retirement contribution, rent paid via ACH. None of those have a
// matching "pair" for Arko to find, so requiring one wrongly excluded
// them from transfer status and let them leak into Spendings as
// regular expenses — the opposite of what this was supposed to fix.
//
// The actual distinguishing signal for "is this really a self-transfer
// or is it money moving to/from another person" is closer to: was it
// sent through a well-known P2P platform. Plaid's TRANSFER_IN/OUT
// category is what catches Venmo/Zelle/Cash App/PayPal payments to or
// from other people and mislabels them as transfers — checking the
// merchant name against those specific platforms catches that case
// without requiring proof of a second connected account. Plaid's own
// classification is trusted as the default; this only overrides it in
// that one specific, well-defined case.
const P2P_PLATFORM_KEYWORDS = ['venmo', 'zelle', 'cash app', 'cashapp', 'paypal'];

function isLikelyP2PPayment(txn) {
  const merchant = (txn.merchant_name || txn.name || '').toLowerCase();
  return P2P_PLATFORM_KEYWORDS.some(kw => merchant.includes(kw));
}

// Same as classifyTxnType, but for the 'transfer' case specifically,
// also checks isLikelyP2PPayment before trusting Plaid's label — see
// that function's comment for why. Kept async even though it no
// longer needs a DB lookup itself, since it's called with await
// throughout the codebase. Credit card payments skip the P2P check
// entirely, since paying down a connected card is inherently a
// self-transfer by definition, never a payment to another person.
async function classifyTxnTypeVerified(userId, txn, linkedAccountId) {
  const rawType = classifyTxnType(txn);
  if (rawType !== 'transfer') return rawType;
  if (isCreditCardPayment(txn)) return 'transfer';
  // Plaid's own classification is trusted by default now — only
  // overridden for the specific, well-defined case of a known P2P
  // platform, where "transfer" really means "paid another person,"
  // not a self-transfer.
  return isLikelyP2PPayment(txn) ? (txn.amount > 0 ? 'expense' : 'income') : 'transfer';
}

async function queueDashboardReviews(userId, addedTransactions) {
  if (!addedTransactions.length) return 0;

  const { data: linkedAccounts } = await supabaseAdmin
    .from('linked_accounts')
    .select('id, plaid_account_id, account_type')
    .eq('user_id', userId);
  if (!linkedAccounts || !linkedAccounts.length) return 0;
  const linkedAccountByPlaidId = Object.fromEntries(linkedAccounts.map(a => [a.plaid_account_id, a.id]));
  const accountTypeById = Object.fromEntries(linkedAccounts.map(a => [a.id, a.account_type]));

  const { data: splits } = await supabaseAdmin
    .from('account_category_splits')
    .select('*')
    .eq('user_id', userId);

  const singleCategoryByAccountId = {};
  linkedAccounts.forEach(a => {
    const accountSplits = (splits || []).filter(s => s.linked_account_id === a.id && s.split_type !== 'envelope');
    if (accountSplits.length === 1 && Number(accountSplits[0].split_percent) === 100) {
      singleCategoryByAccountId[a.id] = accountSplits[0].category_id;
    }
  });

  const { data: categories } = await supabaseAdmin.from('budget_categories').select('id, name').eq('user_id', userId);
  const categoryNameById = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  // Credit cards never have a category mapping (they're a liability, not
  // a spendable category — see openCategoryMapping in connections.js) —
  // but that shouldn't mean their purchases can never be suggested here.
  // Almost every credit card transaction genuinely is an expense, so
  // that's the sensible default; the user can still change it per
  // transaction the same way as any other suggestion.
  const expensesCategory = (categories || []).find(c => (c.name || '').toLowerCase() === 'expenses');
  // Used as the fallback for an unmapped subtract-direction transaction
  // instead of Expenses — per updated direction, a spend with no clear
  // category is more sensibly assumed to be coming out of Checking
  // (the account it's actually likely tied to) than lumped into a
  // generic Expenses bucket by default.
  const checkingCategory = (categories || []).find(c => (c.name || '').toLowerCase() === 'checking');

  // Dashboard's finance_log only has columns for the original four
  // categories — a custom category has nowhere to actually log a
  // transaction against yet. Suggesting one would be a dead end, so only
  // queue for accounts mapped to one of these.
  const LOGGABLE_NAMES = new Set(['savings', 'investment', 'expenses', 'checking']);

  let queuedCount = 0;

  for (const txn of addedTransactions) {
    // A transfer (self-transfer between two of the user's own accounts,
    // or a credit card bill payment) isn't real income/spending, but
    // it's still a real movement of money worth logging — tagged as a
    // transfer rather than an add/subtract, matching how the manual
    // Transfer panel already writes to the log. Credit card payments
    // used to be skipped entirely here (the original purchase was
    // already accounted for when it happened, so the payment felt like
    // it'd double-count) — now they're treated the same as any other
    // self-transfer instead, per updated direction: every transaction
    // should flag for a log, no silent exceptions.

    let isTransfer = classifyTxnType(txn) === 'transfer';
    // Plaid's sign convention: positive = money left the account (a
    // spend), negative = money came in (a deposit). Computed here,
    // ahead of the category-fallback decision below, since which
    // fallback makes sense depends on direction.
    const suggestedAction = txn.amount > 0 ? 'subtract' : 'add';

    const linkedAccountId = linkedAccountByPlaidId[txn.account_id];
    if (!linkedAccountId) continue;

    if (isTransfer) {
      isTransfer = (await classifyTxnTypeVerified(userId, txn, linkedAccountId)) === 'transfer';
    }

    let categoryId, categoryName;
    if (accountTypeById[linkedAccountId] === 'credit_card') {
      // The card side of a general transfer has nowhere sensible to log
      // against — crediting "Expenses" for a payment received would be
      // wrong (it's not spending), and cards were deliberately never
      // given a category of their own to hold real money in.
      if (isTransfer) continue;
      // Same direction-aware fallback as every other account now:
      // Checking first for a subtract (a card purchase, spent from
      // wherever the bill eventually gets paid from), Expenses as the
      // fallback for a refund/credit or if there's no Checking category
      // to use.
      if (suggestedAction === 'subtract' && checkingCategory) {
        categoryId = checkingCategory.id;
        categoryName = checkingCategory.name;
      } else if (expensesCategory) {
        categoryId = expensesCategory.id;
        categoryName = expensesCategory.name;
      } else {
        continue; // no fallback category exists at all for this user yet
      }
    } else {
      // An account with a single, clear category mapping uses that.
      // Anything else — unmapped, split across multiple categories, or
      // mapped to a custom category finance_log has no column for —
      // used to be silently skipped here, so a perfectly normal
      // purchase could just vanish without ever flagging. Falling back
      // instead means every regular transaction gets a chance to show
      // up — worst case it's suggested against the wrong category and
      // gets "Changed" to the right one, rather than not appearing at
      // all. Checking for a subtract (a spend with no clearer home),
      // Expenses for an add (a deposit doesn't really belong there
      // either, but that direction wasn't the one flagged as an issue).
      const mappedCategoryId = singleCategoryByAccountId[linkedAccountId];
      const mappedCategoryName = mappedCategoryId ? categoryNameById[mappedCategoryId] : null;
      if (mappedCategoryId && mappedCategoryName && LOGGABLE_NAMES.has(mappedCategoryName.toLowerCase())) {
        categoryId = mappedCategoryId;
        categoryName = mappedCategoryName;
      } else if (suggestedAction === 'subtract' && checkingCategory) {
        categoryId = checkingCategory.id;
        categoryName = checkingCategory.name;
      } else if (expensesCategory) {
        categoryId = expensesCategory.id;
        categoryName = expensesCategory.name;
      } else {
        continue; // no fallback category exists at all for this user yet — genuinely nothing to log against
      }
    }

    const { data: alreadyQueued } = await supabaseAdmin
      .from('pending_dashboard_reviews')
      .select('id')
      .eq('plaid_transaction_id', txn.transaction_id)
      .maybeSingle();
    if (alreadyQueued) continue;

    // The real source of duplicated Detected activity: when a pending
    // transaction posts, Plaid retires the old transaction_id and
    // issues a brand-new one for what is, in the real world, the exact
    // same purchase. cleanupRemovedReviews already handles this if the
    // old review was still sitting unapproved — but if it had already
    // been approved and logged while pending, that cleanup never runs
    // (there's nothing "pending" left to clean up), and this posted
    // version — new id, same purchase — would otherwise sail through
    // the check above and get queued as if it were something new.
    // Matching on account + amount + a same-day-or-adjacent date isn't
    // a perfect signature, but a genuine second unrelated purchase for
    // the exact same dollar amount on the exact same account within a
    // day of an already-logged one is rare enough that this is a safe
    // trade — and confirming the log entry still exists (via
    // source_review_id) means this only fires for something that's
    // actually already been counted, not just any similar-looking past
    // review.
    const txnDateObj = new Date(txn.date + 'T00:00:00Z');
    const windowStart = new Date(txnDateObj); windowStart.setUTCDate(windowStart.getUTCDate() - 2);
    const windowEnd = new Date(txnDateObj); windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);
    const { data: possibleDuplicate } = await supabaseAdmin
      .from('pending_dashboard_reviews')
      .select('id, finance_log(id)')
      .eq('user_id', userId)
      .eq('linked_account_id', linkedAccountId)
      .eq('status', 'approved')
      .eq('amount', Math.abs(txn.amount))
      .gte('txn_date', windowStart.toISOString().slice(0, 10))
      .lte('txn_date', windowEnd.toISOString().slice(0, 10))
      .neq('plaid_transaction_id', txn.transaction_id);
    const hasLoggedDuplicate = (possibleDuplicate || []).some(r => r.finance_log && r.finance_log.length);
    if (hasLoggedDuplicate) continue;

    // Plaid's sign convention: positive = money left the account (a
    // spend), negative = money came in (a deposit). Same direction
    // logic applies whether it's a real expense or a transfer — money
    // leaving still means "subtract from this category," it's only the
    // logged action_type that differs. (Computed earlier now, ahead of
    // the category-fallback decision above.)

    const { error: insertError } = await supabaseAdmin.from('pending_dashboard_reviews').insert({
      user_id: userId,
      plaid_transaction_id: txn.transaction_id,
      linked_account_id: linkedAccountId,
      category_id: categoryId,
      category_name: categoryNameById[categoryId] || null,
      suggested_action: suggestedAction,
      is_transfer: isTransfer,
      is_credit_card_payment: isCreditCardPayment(txn),
      amount: Math.abs(txn.amount),
      txn_date: txn.date,
      merchant_name: txn.merchant_name || txn.name || null,
      plaid_category: txn.personal_finance_category?.primary || null,
      plaid_detailed_category: txn.personal_finance_category?.detailed || null,
    });
    if (!insertError) queuedCount++;
  }

  return queuedCount;
}

// For every newly-added transaction whose merchant matches a mapping the
// user set up via Spendings' "Map to budget" (on an individual
// transaction, not a subscription), queues a pending_transaction_reviews
// row — same table and same Budget Planner review section subscriptions
// already use, so this is genuinely "another way in" to that same
// pipeline rather than a separate parallel system. Skips transfers (not
// real spending) and anything already queued.
async function matchMerchantMappings(userId, addedTransactions) {
  if (!addedTransactions.length) return 0;

  const { data: mappings } = await supabaseAdmin
    .from('merchant_budget_mappings')
    .select('*')
    .eq('user_id', userId);
  if (!mappings || !mappings.length) return 0;

  const mappingByMerchant = Object.fromEntries(mappings.map(m => [m.merchant_name.toLowerCase(), m]));

  let queuedCount = 0;

  for (const txn of addedTransactions) {
    if (classifyTxnType(txn) === 'transfer') continue; // not real spending, nothing to file into a budget line

    const merchantName = txn.merchant_name || txn.name;
    if (!merchantName) continue;
    const mapping = mappingByMerchant[merchantName.toLowerCase()];
    if (!mapping) continue;

    const { data: alreadyQueued } = await supabaseAdmin
      .from('pending_transaction_reviews')
      .select('id')
      .eq('plaid_transaction_id', txn.transaction_id)
      .maybeSingle();
    if (alreadyQueued) continue;

    const { error: insertError } = await supabaseAdmin.from('pending_transaction_reviews').insert({
      user_id: userId,
      stream_id: 'merchant:' + mapping.merchant_name, // no real Plaid stream involved — a distinct, readable placeholder rather than reusing stream_id's meaning for something it isn't
      plaid_transaction_id: txn.transaction_id,
      amount: Math.abs(txn.amount),
      txn_date: txn.date,
      merchant_name: mapping.merchant_name,
      mapped_cat: mapping.mapped_cat,
      mapped_line_id: mapping.mapped_line_name.toLowerCase(),
      mapped_line_name: mapping.mapped_line_name,
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
// Transaction-only refresh — used by the "Refresh transactions" button,
// which should never also touch subscriptions (see refreshSubscriptionsForItem
// for that half). The cursor-based sync below only returns what's
// actually changed since last time, which is normally right — but a
// manual "refresh" click is explicitly asking to make sure the current
// month is complete, not just to catch deltas, so this also does a
// direct date-range fetch for the current calendar month and merges it
// in (storeTransactions upserts, so this is safe to run every time,
// even when nothing's actually changed).
async function refreshTransactionsForItem(itemRow) {
  const { addedTransactions: rawAdded, modifiedTransactions, removedTransactions } = await syncTransactionsForItem(itemRow);

  const connectedDate = itemRow.created_at ? itemRow.created_at.slice(0, 10) : null;

  const { data: eligibleAccounts } = await supabaseAdmin
    .from('linked_accounts')
    .select('plaid_account_id')
    .eq('user_id', itemRow.user_id)
    .in('account_type', ['checking', 'credit_card']);
  const eligiblePlaidAccountIds = new Set((eligibleAccounts || []).map(a => a.plaid_account_id));

  const now = new Date();
  const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const todayISO = now.toISOString().slice(0, 10);

  let currentMonthTxns = [];
  try {
    const currentMonthResp = await plaidClient.transactionsGet({
      access_token: decryptToken(itemRow.access_token),
      start_date: currentMonthStart,
      end_date: todayISO,
      options: { count: 250 },
    });
    currentMonthTxns = currentMonthResp.data.transactions || [];
  } catch (currentMonthErr) {
    // Non-fatal — the cursor sync above still covers normal operation;
    // this direct fetch is a completeness safety net, not the primary
    // mechanism, so a failure here shouldn't block the regular sync.
    console.error('Current-month supplementary fetch failed:', currentMonthErr?.response?.data || currentMonthErr);
  }

  // De-duplicate against the cursor sync's own results by transaction_id
  // before merging — storeTransactions upserts either way, but there's
  // no reason to process the same transaction twice in one pass.
  const rawAddedIds = new Set(rawAdded.map(t => t.transaction_id));
  const supplementalOnly = currentMonthTxns.filter(t => !rawAddedIds.has(t.transaction_id));
  const allAdded = [...rawAdded, ...supplementalOnly];

  const cardEligible = allAdded.filter(t => eligiblePlaidAccountIds.has(t.account_id));

  // Storage (feeds Spendings' history/charts) and Dashboard review now
  // share the same window — bounded to the previous calendar month
  // onward, computed once from the connection date. This used to be two
  // separate cutoffs, with Dashboard review strictly limited to the
  // moment of connection forward so historical backfill wouldn't
  // trigger a review — but per updated direction, every transaction
  // that shows up in Spendings should get a chance to flag for a log,
  // so there's no longer a reason for the two to diverge.
  const storageCutoff = connectedDate ? startOfPreviousMonth(connectedDate) : null;
  const storageEligible = storageCutoff ? cardEligible.filter(t => t.date >= storageCutoff) : cardEligible;
  const dashboardEligible = storageEligible;

  await storeTransactions(itemRow.user_id, storageEligible, modifiedTransactions, removedTransactions);
  const dashboardQueuedCount = await queueDashboardReviews(itemRow.user_id, dashboardEligible);
  const merchantQueuedCount = await matchMerchantMappings(itemRow.user_id, dashboardEligible);

  await supabaseAdmin
    .from('linked_accounts')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('plaid_item_id', itemRow.item_id)
    .eq('user_id', itemRow.user_id);

  // Full breakdown at each filtering stage — lets a Vercel log entry
  // alone answer "did Plaid even have this transaction yet" (rawCount +
  // supplementalCount) versus "did our own filtering exclude it"
  // (cardEligibleCount vs storageEligibleCount), without needing to dig
  // through the Network tab to figure out which one it was.
  console.log('refreshTransactionsForItem breakdown:', {
    itemId: itemRow.item_id,
    cursorSyncCount: rawAdded.length,
    supplementalFetchCount: supplementalOnly.length,
    cardEligibleCount: cardEligible.length,
    storageEligibleCount: storageEligible.length,
    dashboardQueuedCount,
    merchantQueuedCount,
  });

  return { addedCount: storageEligible.length, dashboardQueuedCount, merchantQueuedCount };
}

// Subscription-only refresh — used by the "Refresh subscriptions"
// button. Matches recurring streams against Budget Planner categories
// using whatever dashboard-eligible transactions are already stored,
// rather than requiring a live transaction sync to have just happened —
// this button shouldn't need to touch transactions at all to do its job.
async function refreshSubscriptionsForItem(itemRow) {
  const streams = await refreshRecurringForItem(itemRow);

  const connectedDate = itemRow.created_at ? itemRow.created_at.slice(0, 10) : null;
  const storageCutoff = connectedDate ? startOfPreviousMonth(connectedDate) : null;
  const { data: linkedAccountRows } = await supabaseAdmin
    .from('linked_accounts')
    .select('id')
    .eq('user_id', itemRow.user_id)
    .eq('plaid_item_id', itemRow.item_id);
  const linkedAccountIds = (linkedAccountRows || []).map(a => a.id);

  let dashboardIds = [];
  if (linkedAccountIds.length) {
    let query = supabaseAdmin
      .from('transactions')
      .select('plaid_transaction_id')
      .eq('user_id', itemRow.user_id)
      .in('linked_account_id', linkedAccountIds);
    if (storageCutoff) query = query.gte('txn_date', storageCutoff);
    const { data: existingTxns } = await query;
    dashboardIds = (existingTxns || []).map(t => t.plaid_transaction_id);
  }

  const queuedCount = await matchAndQueueReviews(itemRow.user_id, streams, dashboardIds);

  await supabaseAdmin
    .from('linked_accounts')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('plaid_item_id', itemRow.item_id)
    .eq('user_id', itemRow.user_id);

  return { streamCount: streams.length, queuedCount };
}

// Combined convenience wrapper — used by the webhook, where a single
// automatic sync event should reasonably do both jobs together. The two
// manual refresh buttons call refreshTransactionsForItem and
// refreshSubscriptionsForItem directly instead, so neither one triggers
// the other.
async function processItemUpdate(itemRow) {
  const txnResult = await refreshTransactionsForItem(itemRow);
  const subResult = await refreshSubscriptionsForItem(itemRow);
  return {
    addedCount: txnResult.addedCount,
    queuedCount: subResult.queuedCount,
    dashboardQueuedCount: txnResult.dashboardQueuedCount,
  };
}

// Re-checks every currently-stored transaction against the review queue,
// not just newly-synced ones — catches anything that fell through the
// cracks in an earlier sync (a webhook that failed partway, a gap
// before some fallback logic existed, etc). queueDashboardReviews
// already skips anything already queued or already logged, so re-
// running it against the full stored history is safe — it only ever
// adds what's genuinely missing.
async function backfillDashboardReviews(userId) {
  const { data: linkedAccounts } = await supabaseAdmin
    .from('linked_accounts')
    .select('id, plaid_account_id, account_type')
    .eq('user_id', userId)
    .in('account_type', ['checking', 'credit_card']);
  if (!linkedAccounts || !linkedAccounts.length) return 0;

  const plaidAccountIdByLinkedId = Object.fromEntries(linkedAccounts.map(a => [a.id, a.plaid_account_id]));
  const linkedAccountIds = linkedAccounts.map(a => a.id);

  const { data: storedTxns } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('is_removed', false)
    .in('linked_account_id', linkedAccountIds);
  if (!storedTxns || !storedTxns.length) return 0;

  // queueDashboardReviews expects Plaid's own transaction shape (a
  // nested personal_finance_category, account_id as Plaid's id rather
  // than our internal one) — reconstructing that from the stored row
  // is simpler than duplicating all of queueDashboardReviews' category-
  // fallback logic a second time just for this backfill path.
  const pseudoTxns = storedTxns.map(t => ({
    transaction_id: t.plaid_transaction_id,
    account_id: plaidAccountIdByLinkedId[t.linked_account_id],
    amount: t.amount,
    date: t.txn_date,
    merchant_name: t.merchant_name,
    name: t.merchant_name,
    pending: t.is_pending,
    personal_finance_category: { primary: t.plaid_category, detailed: t.plaid_detailed_category },
  })).filter(t => t.account_id); // drop anything whose account no longer maps back cleanly

  return await queueDashboardReviews(userId, pseudoTxns);
}

// Finds pending reviews that are almost certainly duplicates of each
// other — same account, same dollar amount, dates within a couple days
// of one another — and keeps only the most recent, dismissing the
// rest. This is the same signature used to *prevent* new duplicates
// from being queued in the first place (see the check inside
// queueDashboardReviews), applied retroactively to whatever's already
// sitting in the queue from before that prevention existed.
// Re-evaluates every currently-pending review's is_transfer and
// is_credit_card_payment flags against the current classification
// logic. Needed because those fields are only ever written once, at
// insert time — a fix to the classification logic itself (like the
// cross-account verification) has no effect on rows that were already
// sitting in the queue before the fix existed. Uses what's already
// stored on the review row (plaid_category, plaid_detailed_category,
// amount, txn_date) to reconstruct enough of a transaction shape to
// re-run the same checks used for new transactions.
// Same problem as reclassifyPendingReviews, on transactions.txn_type
// instead of pending_dashboard_reviews. This one still matters even
// with classification now trusting Plaid by default (rather than
// requiring cross-account verification, which had its own real flaw —
// see classifyTxnTypeVerified) — a transaction stored under an older
// version of this logic can still carry a stale classification that
// nothing re-checks unless explicitly asked to, like here. Spendings
// filters on txn_type = 'transfer' to exclude these, so anything
// stuck with a wrong classification shows up there indefinitely
// otherwise.
async function reclassifyStoredTransactions(userId) {
  const { data: txns } = await supabaseAdmin
    .from('transactions')
    .select('id, amount, txn_date, merchant_name, plaid_category, plaid_detailed_category, txn_type, linked_account_id')
    .eq('user_id', userId)
    .eq('is_removed', false)
    .not('linked_account_id', 'is', null);
  if (!txns || !txns.length) return 0;

  let updatedCount = 0;

  for (const t of txns) {
    const pseudoTxn = {
      amount: t.amount,
      date: t.txn_date,
      merchant_name: t.merchant_name,
      personal_finance_category: { primary: t.plaid_category, detailed: t.plaid_detailed_category },
    };
    const correctedType = await classifyTxnTypeVerified(userId, pseudoTxn, t.linked_account_id);
    if (correctedType !== t.txn_type) {
      await supabaseAdmin.from('transactions').update({ txn_type: correctedType }).eq('id', t.id);
      updatedCount++;
    }
  }

  return updatedCount;
}

async function reclassifyPendingReviews(userId) {
  const { data: pending } = await supabaseAdmin
    .from('pending_dashboard_reviews')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (!pending || !pending.length) return 0;

  let updatedCount = 0;

  for (const review of pending) {
    const pseudoTxn = {
      amount: review.suggested_action === 'subtract' ? review.amount : -review.amount,
      date: review.txn_date,
      merchant_name: review.merchant_name,
      personal_finance_category: { primary: review.plaid_category, detailed: review.plaid_detailed_category },
    };

    const nowIsCreditCardPayment = isCreditCardPayment(pseudoTxn);
    const nowIsTransfer = (await classifyTxnTypeVerified(userId, pseudoTxn, review.linked_account_id)) === 'transfer';

    if (nowIsTransfer !== review.is_transfer || nowIsCreditCardPayment !== review.is_credit_card_payment) {
      await supabaseAdmin.from('pending_dashboard_reviews').update({
        is_transfer: nowIsTransfer,
        is_credit_card_payment: nowIsCreditCardPayment,
      }).eq('id', review.id);
      updatedCount++;
    }
  }

  return updatedCount;
}

async function dedupeDashboardReviews(userId) {
  const { data: pending } = await supabaseAdmin
    .from('pending_dashboard_reviews')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (!pending || pending.length < 2) return 0;

  const claimed = new Set();
  const idsToDismiss = [];

  for (const review of pending) {
    if (claimed.has(review.id)) continue;
    const reviewDate = new Date(review.txn_date + 'T00:00:00Z').getTime();

    const group = pending.filter(other => {
      if (other.id === review.id || claimed.has(other.id)) return false;
      if (other.linked_account_id !== review.linked_account_id) return false;
      if (Number(other.amount) !== Number(review.amount)) return false;
      const otherDate = new Date(other.txn_date + 'T00:00:00Z').getTime();
      return Math.abs(otherDate - reviewDate) <= 2 * 86400000;
    });

    if (group.length) {
      // `pending` is already newest-first, so `review` here is the
      // most recent in the group — keep it, dismiss the rest.
      group.forEach(g => { claimed.add(g.id); idsToDismiss.push(g.id); });
      claimed.add(review.id);
    }
  }

  if (idsToDismiss.length) {
    await supabaseAdmin.from('pending_dashboard_reviews').update({ status: 'dismissed' }).in('id', idsToDismiss);
  }
  return idsToDismiss.length;
}

// First day of the month before the given date's month — e.g. given
// any date in July, returns July's June 1st. Used as the storage
// cutoff so Spendings has "this month + last month" of real history.
function startOfPreviousMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const prevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return prevMonth.toISOString().slice(0, 10);
}

// Same idea as startOfPreviousMonth, just going back further — used for
// the initial historical import. transactionsSync doesn't take a date
// filter at the API level; Plaid always returns everything available
// through the cursor, and the caller filters locally by date. That
// means going back 6 months instead of 1 costs zero additional Plaid
// calls — it's the exact same data already being fetched, just keeping
// more of what comes back instead of discarding it.
function startOfMonthsAgo(dateStr, monthsAgo) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1));
  return target.toISOString().slice(0, 10);
}

module.exports = {
  plaidClient,
  supabaseAdmin,
  mapAccountType,
  classifyTxnType,
  isCreditCardPayment,
  startOfPreviousMonth,
  startOfMonthsAgo,
  syncTransactionsForItem,
  storeTransactions,
  refreshRecurringForItem,
  refreshTransactionsForItem,
  refreshSubscriptionsForItem,
  matchAndQueueReviews,
  matchMerchantMappings,
  queueDashboardReviews,
  backfillDashboardReviews,
  dedupeDashboardReviews,
  reclassifyPendingReviews,
  reclassifyStoredTransactions,
  processItemUpdate,
};