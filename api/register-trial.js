import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, fingerprint } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Already has a billing row? Don't re-create it.
  const { data: mine } = await supabaseAdmin
    .from('user_billing').select('user_id').eq('user_id', userId).maybeSingle();
  if (mine) return res.status(200).json({ ok: true, alreadyExists: true });

  // Has this device fingerprint or IP already claimed a trial under another account?
  let existing = null;
  if (fingerprint) {
    const { data } = await supabaseAdmin
      .from('user_billing')
      .select('user_id')
      .or(`signup_fingerprint.eq.${fingerprint},signup_ip.eq.${ip}`)
      .limit(1);
    existing = data;
  } else {
    const { data } = await supabaseAdmin
      .from('user_billing')
      .select('user_id')
      .eq('signup_ip', ip)
      .limit(1);
    existing = data;
  }

  const alreadyUsedTrial = existing && existing.length > 0;

  const trialStart = new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setMonth(trialEnd.getMonth() + 3);

  const { error } = await supabaseAdmin.from('user_billing').insert({
    user_id: userId,
    trial_start: trialStart.toISOString(),
    // Flagged devices get a trial that's already expired -> forced straight to paywall
    trial_end: alreadyUsedTrial ? trialStart.toISOString() : trialEnd.toISOString(),
    signup_fingerprint: fingerprint || null,
    signup_ip: ip
  });

  if (error) {
    console.error('register-trial insert error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.status(200).json({ ok: true, flagged: alreadyUsedTrial });
}
