// Minimal event emitter: on / off / emit. Listener errors are logged, not thrown.
export function createEmitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (typeof fn !== 'function') return;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
    },
    off(name, fn) {
      map.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(`[signals] '${name}' listener threw`, e); }
      }
    },
    clear() { map.clear(); },
  };
}
