# Glassbreath

Blow a glass vessel with your own breathing.

Glassbreath is a desktop app (Electron) that watches your chest rise and fall through the webcam, using the [Presage SmartSpectra SDK](https://physiology.presagetech.com/). Each slow breath adds a band to a glowing, molten glass vessel on the end of a blowpipe. A deep breath makes a wide band, a short one makes a narrow neck. When you like the shape, smile (or press Space) to cut it off the pipe. It cools into a colour picked from your breathing pace, and you can keep it on the "Cooling rack", a small gallery saved on your computer.

Press "Share" to make a picture card of your vessel (name, breath count, and your breathing pace only if you switch it on). You can copy it, save it, or open a post on X or Bluesky with the picture ready to paste.

It is a toy and a slow-breathing exercise, not a health tool. The numbers on screen are rough camera estimates.

## How the SDK is used

| SmartSpectra output | What it does in Glassbreath |
|---|---|
| `breathing.upperTrace` (about 29 samples a second, about 60 ms delay) | Shapes the glass live. Each breath is cut into inhale and exhale, and its depth sets the width of the next band. |
| `breathing.rate` | Shown as "about N / min" and picks the cooled glass colour (slow breathing gives teal and sea glass, faster gives honey and amber). |
| `cardio.pulseRate` and `arterialPressureTrace` | A soft glow pulse in the hot glass, timed to your heartbeat. |
| `face.expression` (happiness score) | Holding a smile for under a second cuts the glass off the pipe. |
| `face.talking` | Talking pauses the glass, so speech does not get blown into the shape. |
| Validation status and hints | The glass freezes and the SDK's hint ("Place more of the chest in view", and so on) is shown while the picture is not good enough. |

## Requirements

- Linux, macOS or Windows with a webcam. Tested on Ubuntu with Node 22.
- Node.js 20 or newer.
- A Presage API key from <https://physiology.presagetech.com/>.

## Setup

```sh
git clone <this repo>
cd glassbreath
npm install
cp .env.example .env
# then put your key in .env:  SMARTSPECTRA_API_KEY=...
npm start
```

### Linux: Electron sandbox

On some Linux systems Electron stops with "The SUID sandbox helper binary was found, but is not configured correctly". Fix it once after `npm install`:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

You need to do this again after reinstalling Electron. Please don't run the app with `--no-sandbox`.

## Running

| Command | What it does |
|---|---|
| `npm start` | Build and open the app. |
| `npm run start:debug` | Same, with DevTools open. |
| `npm run playground` | Glass engine on its own with sliders, no camera. |
| `npm test` | Unit tests for the signal processing and vessel shape. |
| `npm run cameras` | List the cameras the SDK can see. |
| `npm run probe` | Measure how often and how late each metric arrives. |
| `npm run record -- fixtures/my-session.jsonl` | Record a real session (metrics only, no video) for replay. Set `RECORD_SECONDS` to change the length (default 90). |

### No camera? Use the sample recording

The consent screen has a "Use the sample recording" button. It plays back a recorded stream of SDK metrics, so you can see the whole flow without a webcam or API key. The app labels this clearly as "Sample recording (not live)", and vessels made from it are marked on the rack. If `fixtures/sample-session.jsonl` exists it is used, otherwise the synthetic `fixtures/synthetic-session.jsonl`.

## Privacy and data handling

- **Consent first.** The camera only turns on after you press "Turn on camera". "Turn off camera" stops it, and so does closing the app.
- **On this computer.** The SmartSpectra SDK processes video frames locally. Frames are never uploaded or saved.
- **Network.** The SDK contacts Presage to check the API key.
- **Usage counts are off by default.** The consent screen has a switch for the SDK's anonymous telemetry (one summary per session: SDK version, OS, frame counts, error codes; never video or readings). It stays off unless you turn it on.
- **What is stored.** Nothing, unless you press "Keep on the rack". Then a PNG of the vessel and its shape (band widths, colour, breath count, rounded breathing pace) are saved in the app's user data folder. Pulse is not stored. Delete one vessel or all of them from the rack.
- **Sharing is manual.** Nothing is posted for you. "Share" builds a picture card on this computer. Copy, save and post only happen when you press those buttons, and posting just opens the site in your browser with suggested text. Breathing pace is left off the card unless you turn it on; pulse is never on it.
- **Not medical.** Breathing and pulse are estimates used to shape art. Glassbreath does not diagnose, treat or advise on anything.

## Project layout

```
src/main/main.cjs        Electron main: window, camera permission, key from .env, gallery files
src/preload/preload.js   SDK bridge plus a small window.glassbreath API
src/renderer/app.js      Screens and session flow
src/renderer/signals/    SDK wrapper: breath phases, beats, smile, talking, replay
src/renderer/glass/      three.js vessel: lathe geometry, glass material, cut and cool
src/renderer/ui/         Breathing trace, rack, vessel names
scripts/                 Probe, record and fixture tools
fixtures/                Recorded metric streams for replay
```

## Credits

- [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra) for breathing, pulse and face metrics.
- [three.js](https://threejs.org/) for the glass.
- Fonts: Big Shoulders Display and Big Shoulders Text (Patric King), Kalam (Indian Type Foundry), via Fontsource. Icons: [Phosphor](https://phosphoricons.com/).

## License

MIT. See [LICENSE](LICENSE). The SmartSpectra SDK has its own license.
