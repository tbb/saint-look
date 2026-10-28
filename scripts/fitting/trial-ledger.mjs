import { open, mkdir, readFile, rename, unlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rates, sha256 } from './trial-plan.mjs';

export async function durableWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function openLedger(out, context, recover) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const lockPath = join(out, '.lock');
  try { await access(join(out, '.recovery')); throw new Error('Lock recovery guard remains; stop and reconcile'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function acquire() {
    const lock = await open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); await lock.sync(); } finally { await lock.close(); }
  }
  try { await acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST' || !recover) throw new Error('Trial is locked; do not start concurrent runs');
    // Serialize stale-lock recovery, then re-read under the recovery guard. A second
    // recoverer must never unlink a replacement lock acquired by the first one.
    const recoveryPath = join(out, '.recovery');
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch { throw new Error('Lock recovery already in progress; stop and reconcile'); }
    try {
      const previous = JSON.parse(await readFile(lockPath, 'utf8'));
      if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Cannot safely recover trial lock');
      let dead = false;
      try { process.kill(previous.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
      if (!dead) throw new Error('Trial lock belongs to a running process');
      await unlink(lockPath); await acquire();
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  const path = join(out, 'ledger.json');
  try {
    let data;
    try { data = JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; data = { version: 1, ...context, operations: {} }; }
    if (data.version !== 1 || data.planSha256 !== context.planSha256 || data.approvalSha256 !== context.approvalSha256 || data.mode !== context.mode) throw new Error('Ledger does not match the approved plan');
    const save = () => durableWrite(path, JSON.stringify(data, null, 2));
    await save();
    return {
      data, save,
      async reserve(key, stage, limits) {
        if (data.operations[key]) return data.operations[key];
        const operations = Object.values(data.operations);
        const reserved = operations.reduce((sum, op) => sum + op.reservedMicrousd, 0);
        if (operations.filter(op => op.stage === stage && op.status !== 'skipped').length >= limits.maxCalls[stage] || reserved + rates[stage] > limits.budgetMicrousd) throw new Error('Trial budget/call limit exhausted');
        const op = { key, stage, status: 'started', reservedMicrousd: rates[stage], startedAt: new Date().toISOString() };
        data.operations[key] = op; await save(); return op;
      },
      async artifact(op, bytes, details) {
        const file = `${sha256(op.key).slice(0, 20)}.png`;
        await durableWrite(join(out, file), bytes);
        Object.assign(op, { artifact: file, sha256: sha256(bytes), ...details, status: 'completed', completedAt: new Date().toISOString() });
        await save();
      },
      async readArtifact(op) {
        const bytes = await readFile(join(out, op.artifact));
        if (sha256(bytes) !== op.sha256) throw new Error('Saved artifact hash mismatch; reconcile without resubmitting');
        return bytes;
      },
      close: () => unlink(lockPath),
    };
  } catch (error) { await unlink(lockPath); throw error; }
}
