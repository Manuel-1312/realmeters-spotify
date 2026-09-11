# RealMeters

A full-screen, mastering-style audio-metering visualizer for Spotify ([Spicetify](https://spicetify.app)
custom app). It shows the **real output signal** — not Spotify's precomputed analysis — in a compact
layout: spectrogram, spectrum, waveform, oscilloscope, stereometer and LUFS / true-peak.

The numbers are real: a −20 dBFS tone reads −20.00 LUFS / −19.99 dBTP.

## How it works
The drawing runs inside Spotify. The measurements come from a small local companion —
**[minimeters-bridge](https://github.com/Manuel-1312/minimeters-bridge)** — which captures the
default Windows output through WASAPI loopback, computes FFT / EBU R128 loudness / true peak /
correlation and streams them over `ws://127.0.0.1:8985`. This custom app only draws them.

**You need the bridge running.** Without it the view shows *bridge sin conexión*.
Because the bridge uses WASAPI loopback, this is **Windows only** for now.

## Install
1. Install and run the bridge — see [minimeters-bridge](https://github.com/Manuel-1312/minimeters-bridge).
2. Build and install this custom app:

       npm install
       npm run build
       # copy dist/ into %APPDATA%\spicetify\CustomApps\realmeters\
       spicetify config custom_apps realmeters
       spicetify apply

3. Open **RealMeters** from the left sidebar in Spotify and start playing something.

Prefer the Marketplace? Install [Spicetify Marketplace](https://github.com/spicetify/marketplace)
and search for *RealMeters*.

## Notes
- Independent, unofficial project. The mastering-style layout is inspired by the
  [MiniMeters](https://minimeters.app) desktop app; RealMeters is not affiliated with or endorsed by it.
- The visualizer renders at the browser refresh rate; the analysis and the spectrogram scroll
  run at the bridge frame rate (144 fps by default).

## License
MIT — see [LICENSE](LICENSE).
