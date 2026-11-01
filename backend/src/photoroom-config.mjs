// Select one explicit credential family; never fall back across billing modes.
export function photoroomConfiguration(env) {
  const mode = env.SAINT_LOOK_PHOTOROOM_MODE || 'sandbox';
  const key = mode === 'production' ? env.PHOTOROOM_API_KEY
    : env.PHOTOROOM_SANDBOX_API_KEY || env.PHOTOROOM_API_KEY;
  const configured = typeof key === 'string' && /^[A-Za-z0-9_+/.=-]{8,1024}$/.test(key)
    && (mode === 'sandbox' ? key.startsWith('sandbox_')
      : mode === 'production' && env.PHOTOROOM_PRODUCTION_APPROVED === 'true' && !key.startsWith('sandbox_'));
  return { mode, key, configured };
}
