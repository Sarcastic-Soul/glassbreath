# Agent notes for Glassbreath

Electron app. Plain JS (ES modules in the renderer, CommonJS in main). esbuild bundles into `dist/`.

- Build: `node build.mjs`. Tests: `npm test` (plain `node --test`; do not pass a folder).
- Run: `npm start`. Replay without a camera: the "Use the sample recording" button.
- Never commit `.env` or the API key. Never add `--no-sandbox` to shipped code.
- The preload is sandboxed, so it must stay bundled (`dist/preload.js`); it can only require `electron`.
- Module boundaries: `signals/` talks to the SDK and emits plain events; `glass/` only knows three.js and the stage API; `app.js` wires them. Keep it that way.
- Signal facts (measured with this key): `breathing.upperTrace` ~29 samples/s, ~60 ms delay; `breathing.rate` ~0.2/s; `cardio.pulseRate` ~1/s; no `lowerTrace` or apnea. SDK error code 1 (kInvalidState) fires once during stop and is ignored while stopping.
- Hackathon rules: no medical, diagnosis or treatment claims in UI or docs; camera only after consent; telemetry off by default; do not store pulse.
- UI: Phosphor icons only. No blue/purple gradients, no gradient text. Plain English copy.
