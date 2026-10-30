// One explicitly approved trial budget. Reservations survive crashes and failed
// provider calls: uncertainty must never create another free attempt.
const providers = ['photoroom', 'jev', 'gemini'];
const ceilings = { photoroom: 60, jev: 48, gemini: 24 };
const prices = { photoroom: 0, jev: 2753, gemini: 400000 };
export class ProviderBudgetError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function validateApiBudget(input, now = Date.now()) {
  let value;
  try { value = typeof input === 'string' ? JSON.parse(input) : input; } catch {}
  const checked = Date.parse(value?.pricesCheckedAt);
  if (!value || value.approved !== true || value.id !== 'epic63-public-v1-5d85dde081e8'
    || !Number.isFinite(checked) || checked > now || now - checked > 86400000
    || !Number.isSafeInteger(value.maxCostMicrousd) || value.maxCostMicrousd <= 0 || value.maxCostMicrousd > 4500000
    || providers.some(p => !Number.isSafeInteger(value.limits?.[p]) || value.limits[p] < 0 || value.limits[p] > ceilings[p]
      || value.ratesMicrousd?.[p] !== prices[p])) {
    throw new ProviderBudgetError('provider_budget_not_approved');
  }
  return { id: value.id, approved: true, pricesCheckedAt: value.pricesCheckedAt,
    limits: Object.fromEntries(providers.map(p => [p, value.limits[p]])),
    ratesMicrousd: { ...prices }, maxCostMicrousd: value.maxCostMicrousd };
}

export function createProviderBudget(database, env) {
  // Controlled tests never spend money. An explicit policy exercises the same
  // persistent accounting through HTTP; production has no bypass.
  if (env.NODE_ENV === 'test' && !env.SAINT_LOOK_API_BUDGET_JSON && env.SAINT_LOOK_TEST_REQUIRE_API_BUDGET !== 'true') {
    return { reserve() {}, available() { return true; } };
  }
  database.exec(`CREATE TABLE IF NOT EXISTS provider_budgets (id TEXT PRIMARY KEY, policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_reservations (
      budget_id TEXT NOT NULL, provider TEXT NOT NULL, operation_key TEXT NOT NULL,
      cost_microusd INTEGER NOT NULL, reserved_at INTEGER NOT NULL,
      PRIMARY KEY(budget_id, provider, operation_key)
    )`);
  const readPolicy = () => validateApiBudget(env.SAINT_LOOK_API_BUDGET_JSON);
  function policyIdentity(policy) {
    const { pricesCheckedAt, ...identity } = policy;
    return JSON.stringify(identity);
  }
  function remaining(policy, provider) {
    const total = database.prepare('SELECT COALESCE(SUM(cost_microusd),0) AS cost FROM provider_reservations WHERE budget_id=?').get(policy.id).cost;
    // Keep Nano Banana trial counts continuous across the fal -> Gemini rename.
    const count = provider === 'gemini'
      ? database.prepare("SELECT COUNT(*) AS count FROM provider_reservations WHERE budget_id=? AND provider IN ('gemini','fal')").get(policy.id).count
      : database.prepare('SELECT COUNT(*) AS count FROM provider_reservations WHERE budget_id=? AND provider=?').get(policy.id, provider).count;
    return count < policy.limits[provider] && total + policy.ratesMicrousd[provider] <= policy.maxCostMicrousd;
  }
  function assertPolicy(policy) {
    const old = database.prepare('SELECT policy FROM provider_budgets WHERE id=?').get(policy.id);
    if (!old || old.policy === policyIdentity(policy)) return;
    // The deployed trial ledger originally named Nano Banana Pro's provider
    // `fal`. Migrate only that exact known policy identity in place. Historical
    // reservation rows remain untouched and continue contributing to total cost.
    let previous;
    try { previous = JSON.parse(old.policy); } catch {}
    const isFalPolicy = previous?.id === policy.id && previous.approved === true
      && previous.maxCostMicrousd === policy.maxCostMicrousd
      && JSON.stringify(previous.limits) === JSON.stringify({ photoroom: 60, jev: 48, fal: 24 })
      && JSON.stringify(previous.ratesMicrousd) === JSON.stringify({ photoroom: 0, jev: 2753, fal: 150000 });
    if (!isFalPolicy) throw new ProviderBudgetError('provider_budget_not_approved');
    database.prepare('UPDATE provider_budgets SET policy=? WHERE id=?').run(policyIdentity(policy), policy.id);
  }
  return {
    available(provider) {
      try {
        const policy = readPolicy(); assertPolicy(policy);
        return (provider ? [provider] : providers).every(p => providers.includes(p) && remaining(policy, p));
      } catch { return false; }
    },
    reserve(provider, operationKey) {
      if (!providers.includes(provider) || typeof operationKey !== 'string' || !operationKey || operationKey.length > 256) {
        throw new ProviderBudgetError('invalid_budget_reservation');
      }
      const policy = readPolicy();
      database.exec('BEGIN IMMEDIATE');
      try {
        assertPolicy(policy);
        database.prepare('INSERT OR IGNORE INTO provider_budgets VALUES (?,?)').run(policy.id, policyIdentity(policy));
        if (database.prepare('SELECT 1 FROM provider_reservations WHERE budget_id=? AND provider=? AND operation_key=?')
          .get(policy.id, provider, operationKey)) throw new ProviderBudgetError('provider_request_already_reserved');
        if (!remaining(policy, provider)) throw new ProviderBudgetError('provider_budget_exhausted');
        database.prepare('INSERT INTO provider_reservations VALUES (?,?,?,?,?)')
          .run(policy.id, provider, operationKey, policy.ratesMicrousd[provider], Date.now());
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}
