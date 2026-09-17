const store = require('./db');

// Per-user daily quotas for LLM-backed routes (cost control once more than
// one person uses the app). Counted in a transaction BEFORE the (billed,
// slow) LLM call, so a burst of concurrent requests can't all slip through.
// The owner is unlimited. Pattern from the newsfeed app's member quotas.
//
//   router.post('/', async (req, res) => {
//     await enforceQuota(req, 'chat', 30);
//     ...
//   });

const todayKey = () => new Date().toISOString().slice(0, 10); // UTC day

async function enforceQuota(req, field, limit) {
  if (req.user && req.user.role === 'owner') return;
  const ref = store.userCol(req.uid, 'usage').doc(todayKey());
  await store.db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists && snap.data()[field]) || 0;
    if (current >= limit) {
      const err = new Error(`Daily limit reached for ${field}. Try again tomorrow.`);
      err.status = 429;
      throw err;
    }
    tx.set(ref, { [field]: current + 1 }, { merge: true });
  });
}

module.exports = { enforceQuota };
