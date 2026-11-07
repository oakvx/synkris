/**
 * booking/holds: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { HOLD_LOCK_TIMEOUT, HOLD_MINUTES, __holdLock, loadHolds, log, now, saveHolds, slotOverlapsExistingBookings } = dependencies;

function cleanupHolds() {
  const now = Date.now();
  const arr = loadHolds();
  const next = arr.filter((h) => Number(h.expiresAt) > now);
  if (next.length !== arr.length) saveHolds(next);
  return next;
}

function getHoldIntervalsForDay(day, email, {
  ignoreChatId = null
} = {}) {
  const D = day instanceof Date ? day : new Date(day);
  const start = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const arr = cleanupHolds();
  const out = [];
  for (const h of arr) {
    if (ignoreChatId && h.chatId === ignoreChatId) continue;
    if (
      email &&
      String(h.professionalEmail || "").toLowerCase() !==
      String(email || "").toLowerCase()
    )
      continue;
    const s = Number(h.startMs),
      e = Number(h.endMs);
    if (Number.isFinite(s) && Number.isFinite(e) && s < end && e > start)
      out.push([s, e]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

async function __withHoldLock(chatId, fn) {
  const key = String(chatId || 'global');

  // Attendi lock precedente con timeout
  if (__holdLock.has(key)) {
    const lockPromise = __holdLock.get(key);
    try {
      await Promise.race([
        lockPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Hold lock timeout')), HOLD_LOCK_TIMEOUT)
        )
      ]);
    } catch (err) {
      log('warn', '[HOLD_LOCK] Timeout o errore in lock precedente', {
        chatId: key,
        error: String(err)
      });
    }
  }

  // Crea nuovo lock
  let resolve, reject;
  const lockPromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  __holdLock.set(key, lockPromise);

  try {
    const result = await fn();
    resolve();
    return result;
  } catch (err) {
    reject(err);
    throw err;
  } finally {
    // Rimuovi lock solo se è ancora il nostro
    if (__holdLock.get(key) === lockPromise) {
      __holdLock.delete(key);
    }
  }
}

function acquireSoftHold({
  chatId,
  professionalEmail,
  startTime,
  durationMin,
}) {
  // FIX Bug #3: Operazione atomica con lock
  return __withHoldLock(chatId, () => {
    try {
      const s =
        startTime instanceof Date ?
          startTime.getTime() :
          new Date(startTime).getTime();
      const e = s + (Number(durationMin) || 30) * 60_000;
      const now = Date.now();
      const proEmail = String(professionalEmail || "").trim().toLowerCase();

      // ATOMICO: carica, valida, salva in una singola operazione
      let arr = cleanupHolds();

      // già tenuto da questo chat? aggiorna deadline (MA non bypassare conflitti con booking)
      for (const h of arr) {
        if (
          h.chatId === chatId &&
          String(h.professionalEmail || "").trim().toLowerCase() === proEmail &&
          h.startMs === s
        ) {
          // Se nel frattempo lo slot è diventato "booking", non rinnovare (evita doppie prenotazioni)
          if (slotOverlapsExistingBookings(proEmail, s, e, {
            ignoreChatId: chatId
          })) {
            log('warn', '[HOLD] Slot già prenotato (renew bloccato)', {
              chatId,
              time: new Date(s).toISOString()
            });
            return false;
          }

          h.expiresAt = now + HOLD_MINUTES * 60_000;
          saveHolds(arr);
          log('debug', '[HOLD] Rinnovato hold esistente', {
            chatId,
            time: new Date(s).toISOString()
          });
          return true;
        }
      }

      // FIX: Check conflitti PRIMA di modificare array
      // conflitti con altri hold
      for (const h of arr) {
        if (String(h.professionalEmail || "").trim().toLowerCase() === proEmail) {
          if (s < h.endMs && h.startMs < e && h.chatId !== chatId) {
            log('warn', '[HOLD] Slot già in hold da altro utente', {
              chatId,
              conflictWith: h.chatId,
              time: new Date(s).toISOString()
            });
            return false;
          }
        }
      }

      // conflitti con booking esistenti
      if (slotOverlapsExistingBookings(proEmail, s, e, {
        ignoreChatId: chatId
      })) {
        log('warn', '[HOLD] Slot già prenotato', {
          chatId,
          time: new Date(s).toISOString()
        });
        return false;
      }

      // crea hold
      arr.push({
        id: `${proEmail}|${s}|${chatId}|${now}`,
        professionalEmail: proEmail,
        chatId,
        startMs: s,
        endMs: e,
        createdAt: now,
        expiresAt: now + HOLD_MINUTES * 60_000,
      });

      saveHolds(arr);
      log('info', '[HOLD] Acquisito nuovo hold', {
        chatId,
        time: new Date(s).toISOString()
      });
      return true;
    } catch (err) {
      log('error', '[HOLD] Errore in acquireSoftHold', {
        chatId,
        error: String(err)
      });
      return false;
    }
  });
}

function releaseSoftHoldByChat(chatId) {
  const arr = loadHolds();
  const next = arr.filter((h) => h.chatId !== chatId);
  if (next.length !== arr.length) saveHolds(next);
}

async function __withAutoReleaseHold(chatId, holdFn, workFn) {
  let holdAcquired = false;
  try {
    holdAcquired = await holdFn();
    if (!holdAcquired) {
      log('warn', '[HOLD] Impossibile acquisire hold', {
        chatId
      });
      return {
        success: false,
        reason: 'hold_failed'
      };
    }

    const result = await workFn();
    return {
      success: true,
      result
    };
  } catch (err) {
    log('error', '[HOLD] Errore durante operazione con hold', {
      chatId,
      error: String(err)
    });
    return {
      success: false,
      reason: 'error',
      error: err
    };
  } finally {
    // SEMPRE rilascia hold, anche in caso di errore
    if (holdAcquired) {
      releaseSoftHoldByChat(chatId);
      log('debug', '[HOLD] Hold rilasciato', {
        chatId
      });
    }
  }
}

  return { cleanupHolds, getHoldIntervalsForDay, __withHoldLock, acquireSoftHold, releaseSoftHoldByChat, __withAutoReleaseHold };
}
