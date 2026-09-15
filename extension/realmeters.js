// RealMeters - Spicetify extension
// =============================================================================
// Broadcast-grade audio meters (spectrogram, spectrum, waveform, oscilloscope,
// stereometer and EBU R128 loudness) drawn inside Spotify from the REAL output
// signal. The numbers come from the companion "minimeters-bridge": a small local
// program that captures the WASAPI loopback of the default output and streams the
// measurements over ws://127.0.0.1:8985. A browser extension cannot capture system
// audio itself, so the bridge must be running - see the repo README.
//
// The drawing is a standalone port of this repo's custom-app renderer (plain
// canvas); only the shell (button + full-screen overlay + render loop) is new.
// Independent, unofficial project; the mastering-style layout is inspired by the
// MiniMeters desktop app but is not affiliated with or endorsed by it.
// =============================================================================
(function RealMeters() {
	const S_API = window.Spicetify;
	if (!(S_API && (S_API.Playbar?.Button || S_API.Topbar?.Button) && S_API.Player && document.body)) {
		setTimeout(RealMeters, 300);
		return;
	}

	// ---- protocolo del bridge (ver docstring de bridge.py) ----
	const BRIDGE_URL = "ws://127.0.0.1:8985";
	const HDR = 32;
	const NMEL = 512;
	const NSCOPE = 512;
	const NVEC = 192;
	const OFF_MEL = HDR;
	const OFF_SCOPE = HDR + NMEL;
	const OFF_VEC = HDR + NMEL + NSCOPE;
	const FRAME_FLOATS = OFF_VEC + 3 * NVEC * 2;
	const F_LO = 20;
	const F_HI = 20000;
	const H = {
		LUFS_M: 2, LUFS_S: 3, LUFS_I: 4, LRA: 5, TP_L: 6, TP_R: 7,
		CORR: 8, CORR_LOW: 9, CORR_MID: 10, CORR_HIGH: 11,
		PEAK_HZ: 12, PEAK_DB: 13, F0: 14, F0_CONF: 15,
		RMS_LOW: 16, RMS_MID: 17, RMS_HIGH: 18,
		WAVE_MIN: 19, WAVE_MAX: 20, WAVE_RMS: 21, SP_L: 22, SP_R: 23
	};

	// ---- preset "Analisis Master" ----
	const PRESET = {
		spectrum: { centerDb: -50, rangeDb: 60, tilt: 4.5, smoothing: 0.9, targetOffset: 12 },
		spectrogram: { contrast: 0.5, tilt: 4.5, floorDb: -86, rangeDb: 70 },
		waveform: { colPx: 2, floorDb: -60 },
		stereometer: { pointSize: 3 },
		loudness: { scaleLu: 50, expandLu: 24, expandFrac: 0.72, ticks: [0, 6, 12, 24, 36, 50] }
	};

	// ---- tema Darktable ----
	const T = {
		bg: "#000000", bg2: "rgb(48,48,48)", text: "rgb(164,164,164)",
		primary: "rgb(192,192,192)", secondary: "rgb(96,96,96)", error: "rgba(252,8,3,0.75)",
		tooltipBg: "rgba(12,12,12,0.92)", tooltipText: "rgb(192,192,192)", wave: "rgba(192,192,192,0.31)",
		hLow: "rgba(48,136,208,0.75)", hMid: "rgba(252,8,3,0.75)", hHigh: "rgba(255,192,71,0.75)",
		stGuides: "rgb(92,92,92)", stLow: "rgba(48,136,208,0.75)", stMid: "rgba(252,8,3,0.75)",
		stHigh: "rgba(255,192,71,0.75)", stPrimary: "rgb(255,255,255)", loudPrimary: "rgb(164,164,164)",
		loudText: "rgb(0,0,0)", osc: "rgb(164,164,164)", specLine: "rgba(164,164,164,0.63)",
		specSecondary: "rgba(127,127,127,0.75)", specFreqLines: "rgb(96,96,96)"
	};
	const CMAP = [
		[0.0, 11, 11, 28], [0.196121, 24, 26, 69], [0.4, 40, 41, 100],
		[0.599138, 252, 8, 3], [0.79, 255, 255, 71], [1.0, 255, 255, 255]
	];
	const MONO = "Consolas, 'Cascadia Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

	function colormap(t) {
		t = Math.min(1, Math.max(0, t));
		for (let i = 1; i < CMAP.length; i++) {
			if (t <= CMAP[i][0]) {
				const a = CMAP[i - 1], b = CMAP[i];
				const f = (t - a[0]) / (b[0] - a[0] || 1);
				return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
			}
		}
		const l = CMAP[CMAP.length - 1];
		return [l[1], l[2], l[3]];
	}
	function buildLut() {
		const lut = new Uint8ClampedArray(256 * 3);
		for (let i = 0; i < 256; i++) {
			const c = colormap(i / 255);
			lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
		}
		return lut;
	}
	const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
	const hzToMel = f => 2595 * Math.log10(1 + f / 700);
	const melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);
	const MEL_LO = hzToMel(F_LO);
	const MEL_HI = hzToMel(F_HI);
	const binFreq = i => melToHz(MEL_LO + ((i + 0.5) / NMEL) * (MEL_HI - MEL_LO));
	const xOfFreq = (f, w) => ((hzToMel(f) - MEL_LO) / (MEL_HI - MEL_LO)) * w;
	const freqOfX = (x, w) => melToHz(MEL_LO + (x / w) * (MEL_HI - MEL_LO));
	const tiltAt = (f, dbPerOct) => dbPerOct * Math.log2(f / 1000);

	const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
	function noteOf(f) {
		if (!(f > 0)) return { name: "--", cents: 0 };
		const midi = 69 + 12 * Math.log2(f / 440);
		const n = Math.round(midi);
		return { name: NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1), cents: Math.round((midi - n) * 100) };
	}
	const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(2) + "kHz" : f.toFixed(2) + "Hz");
	const fmtFreqLabel = f => (f >= 1000 ? f / 1000 + "kHz" : f + "Hz");

	// ---- conexión con el bridge ----
	class MeterLink {
		constructor(win) {
			this.win = win;
			this.ws = null;
			this.frame = null;
			this.seq = 0;
			this.connected = false;
			this.lastAt = 0;
			this.timer = null;
			this.closed = false;
			this.connect();
		}
		connect() {
			if (this.closed) return;
			try {
				const ws = new this.win.WebSocket(BRIDGE_URL);
				ws.binaryType = "arraybuffer";
				ws.onopen = () => { this.connected = true; };
				ws.onmessage = ev => {
					const d = ev.data;
					if (d instanceof ArrayBuffer && d.byteLength >= FRAME_FLOATS * 4) {
						this.frame = new Float32Array(d, 0, FRAME_FLOATS);
						this.seq++;
						this.lastAt = this.win.performance.now();
					}
				};
				ws.onclose = () => { this.connected = false; this.ws = null; this.schedule(); };
				ws.onerror = () => { try { ws.close(); } catch (e) {} };
				this.ws = ws;
			} catch (e) {
				this.schedule();
			}
		}
		schedule() {
			if (this.closed || this.timer !== null) return;
			this.timer = this.win.setTimeout(() => { this.timer = null; this.connect(); }, 2000);
		}
		get live() {
			return this.connected && this.frame !== null && this.win.performance.now() - this.lastAt < 2000;
		}
		send(msg) {
			if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
		}
		close() {
			this.closed = true;
			if (this.timer !== null) this.win.clearTimeout(this.timer);
			try { this.ws && this.ws.close(); } catch (e) {}
		}
	}

	const WAVE_CAP = 4096;
	const SILENCE_LUFS = -70;

	function makeState() {
		const tilt = new Float32Array(NMEL);
		for (let i = 0; i < NMEL; i++) tilt[i] = tiltAt(binFreq(i), PRESET.spectrum.tilt);
		const cols = [];
		for (let i = 0; i < WAVE_CAP; i++) cols.push({ min: 0, max: 0, low: -120, mid: -120, high: -120 });
		return {
			isError: false, link: null, canvas: null, seq: -1, lut: buildLut(), tilt,
			specLine: new Float32Array(NMEL).fill(-120),
			specFillT: new Float32Array(NMEL).fill(-120),
			specFill: new Float32Array(NMEL).fill(-120),
			spectro: { canvas: null, w: 0, h: 0, rowBin: new Int32Array(0), col: null },
			wave: { cols, head: 0 },
			bandSm: { low: -120, mid: -120, high: -120 },
			osc: { gain: 1 }, stereo: { gain: 1 }, loud: { holdL: -120, holdR: -120 },
			mouse: null, onMove: null, onLeave: null, silentSince: -1, alpha: 1,
			lastT: 0, nextRenderT: 0, spectroSeq: 0
		};
	}

	// ---- ingestión de un frame nuevo ----
	function ingest(S, f, now) {
		const dt = S.lastT > 0 ? Math.min(0.1, (now - S.lastT) / 1000) : 1 / 50;
		S.lastT = now;
		const sm = PRESET.spectrum.smoothing;
		for (let i = 0; i < NMEL; i++) {
			const raw = f[OFF_MEL + i] + S.tilt[i];
			const l = S.specLine[i];
			S.specLine[i] = l + (raw - l) * (raw > l ? 0.65 : 0.3);
			const t = S.specFillT[i];
			S.specFillT[i] = t + (raw - t) * (raw > t ? 0.5 : 1 - sm);
		}
		const K = 5;
		let acc = 0;
		for (let i = -K; i <= K; i++) acc += S.specFillT[clamp(i, 0, NMEL - 1)];
		for (let i = 0; i < NMEL; i++) {
			S.specFill[i] = acc / (2 * K + 1);
			acc += S.specFillT[clamp(i + K + 1, 0, NMEL - 1)] - S.specFillT[clamp(i - K, 0, NMEL - 1)];
		}
		const c = S.wave.cols[S.wave.head % WAVE_CAP];
		c.min = f[H.WAVE_MIN];
		c.max = f[H.WAVE_MAX];
		const B = S.bandSm;
		B.low += (f[H.RMS_LOW] - B.low) * 0.4;
		B.mid += (f[H.RMS_MID] - B.mid) * 0.4;
		B.high += (f[H.RMS_HIGH] - B.high) * 0.4;
		c.low = B.low; c.mid = B.mid; c.high = B.high;
		S.wave.head++;
		S.loud.holdL = Math.max(f[H.TP_L], S.loud.holdL - 12 * dt);
		S.loud.holdR = Math.max(f[H.TP_R], S.loud.holdR - 12 * dt);
	}

	// ---- módulos ----
	function drawSpectrogram(ctx, a, S, f, nNew) {
		const sp = S.spectro;
		const w = Math.max(1, Math.floor(a.w));
		const h = Math.max(1, Math.floor(a.h));
		if (!sp.canvas || sp.w !== w || sp.h !== h) {
			const doc = ctx.canvas.ownerDocument;
			const c = doc.createElement("canvas");
			c.width = w; c.height = h;
			const octx = c.getContext("2d");
			if (octx) {
				octx.fillStyle = T.bg;
				octx.fillRect(0, 0, w, h);
				if (sp.canvas) octx.drawImage(sp.canvas, w - sp.w, h - sp.h, sp.w, sp.h);
			}
			sp.canvas = c; sp.w = w; sp.h = h;
			sp.rowBin = new Int32Array(h);
			for (let j = 0; j < h; j++) sp.rowBin[j] = clamp(Math.floor((1 - (j + 0.5) / h) * NMEL), 0, NMEL - 1);
			sp.col = octx ? octx.createImageData(1, h) : null;
		}
		const octx = sp.canvas.getContext("2d");
		if (octx && f && nNew > 0 && sp.col) {
			const adv = Math.min(nNew, 24);
			octx.drawImage(sp.canvas, -adv, 0);
			const d = sp.col.data;
			const { floorDb, rangeDb, contrast } = PRESET.spectrogram;
			const gamma = 1 + (1 - contrast) * 0.7;
			for (let j = 0; j < h; j++) {
				const b = sp.rowBin[j];
				let t = (f[OFF_MEL + b] + S.tilt[b] - floorDb) / rangeDb;
				t = Math.pow(clamp(t, 0, 1), gamma);
				const li = Math.round(t * 255) * 3;
				d[j * 4] = S.lut[li]; d[j * 4 + 1] = S.lut[li + 1]; d[j * 4 + 2] = S.lut[li + 2]; d[j * 4 + 3] = 255;
			}
			for (let k = 0; k < adv; k++) octx.putImageData(sp.col, w - adv + k, 0);
		}
		ctx.drawImage(sp.canvas, a.x, a.y);
	}

	function drawWaveform(ctx, a, S, s) {
		const colW = Math.max(1, Math.round(s(PRESET.waveform.colPx)));
		const n = Math.min(WAVE_CAP, Math.floor(a.w / colW));
		const yc = a.y + a.h / 2;
		const half = a.h / 2;
		const gain = 1.4;
		const floor = PRESET.waveform.floorDb;
		const yDb = db => a.y + a.h * clamp(1 - (db - floor) / -floor, 0, 1);
		ctx.save();
		ctx.beginPath();
		ctx.rect(a.x, a.y, a.w, a.h);
		ctx.clip();
		ctx.strokeStyle = T.bg2;
		ctx.fillStyle = T.secondary;
		ctx.font = `${s(9)}px ${MONO}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.lineWidth = 1;
		const pxPerSec = 50 * colW;
		for (let sec = 1; sec * pxPerSec < a.w; sec++) {
			const x = a.x + a.w - sec * pxPerSec;
			ctx.beginPath();
			ctx.moveTo(x, a.y + a.h - s(12));
			ctx.lineTo(x, a.y + a.h);
			ctx.stroke();
			ctx.fillText(`-${sec}s`, x, a.y + a.h - s(1));
		}
		ctx.strokeStyle = T.wave;
		ctx.lineWidth = colW;
		ctx.beginPath();
		const start = S.wave.head - n;
		for (let k = 0; k < n; k++) {
			const idx = start + k;
			if (idx < 0) continue;
			const c = S.wave.cols[idx % WAVE_CAP];
			const x = a.x + a.w - (n - k) * colW + colW / 2;
			const y0 = yc - clamp(c.max * gain, -1, 1) * half;
			const y1 = yc - clamp(c.min * gain, -1, 1) * half;
			ctx.moveTo(x, Math.min(y0, y1 - 1));
			ctx.lineTo(x, Math.max(y1, y0 + 1));
		}
		ctx.stroke();
		const bands = [["low", T.hLow], ["mid", T.hMid], ["high", T.hHigh]];
		ctx.lineWidth = s(1.2);
		ctx.lineJoin = "round";
		ctx.globalAlpha *= 0.85;
		for (const [key, color] of bands) {
			ctx.strokeStyle = color;
			ctx.beginPath();
			let started = false;
			for (let k = 0; k < n; k++) {
				const idx = start + k;
				if (idx < 0) continue;
				const c = S.wave.cols[idx % WAVE_CAP];
				const x = a.x + a.w - (n - k) * colW + colW / 2;
				const y = yDb(c[key]);
				if (!started) { ctx.moveTo(x, y); started = true; }
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
		}
		ctx.restore();
	}

	function drawOscilloscope(ctx, a, S, f, s) {
		if (!f) return;
		let peak = 1e-4;
		for (let i = 0; i < NSCOPE; i++) peak = Math.max(peak, Math.abs(f[OFF_SCOPE + i]));
		const target = clamp(0.92 / peak, 1, 60);
		S.osc.gain += (target - S.osc.gain) * (target < S.osc.gain ? 0.35 : 0.06);
		const yc = a.y + a.h / 2;
		ctx.save();
		ctx.beginPath();
		ctx.rect(a.x, a.y, a.w, a.h);
		ctx.clip();
		ctx.strokeStyle = T.osc;
		ctx.lineWidth = s(1.25);
		ctx.lineJoin = "round";
		ctx.beginPath();
		for (let i = 0; i < NSCOPE; i++) {
			const x = a.x + (i / (NSCOPE - 1)) * a.w;
			const y = yc - clamp(f[OFF_SCOPE + i] * S.osc.gain, -1, 1) * (a.h / 2 - s(2));
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
		const f0 = f[H.F0];
		const conf = f[H.F0_CONF];
		if (conf >= 0.5 && f0 > 0) {
			const nt = noteOf(f0);
			ctx.fillStyle = T.secondary;
			ctx.font = `${s(9)}px ${MONO}`;
			ctx.textAlign = "right";
			ctx.textBaseline = "top";
			ctx.fillText(`${f0.toFixed(1)}Hz ${nt.name}`, a.x + a.w - s(4), a.y + s(3));
		}
		ctx.restore();
	}

	const FREQ_LINES = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];
	function drawSpectrum(ctx, a, S, f, s) {
		const { centerDb, rangeDb, targetOffset } = PRESET.spectrum;
		const bottomDb = centerDb - rangeDb / 2;
		const yDb = db => a.y + a.h * (1 - clamp((db - bottomDb) / rangeDb, 0, 1.15));
		ctx.save();
		ctx.beginPath();
		ctx.rect(a.x, a.y, a.w, a.h);
		ctx.clip();
		const A = ctx.globalAlpha;
		ctx.lineWidth = 1;
		ctx.strokeStyle = T.specFreqLines;
		ctx.globalAlpha = A * 0.55;
		for (const fr of FREQ_LINES) {
			const x = Math.round(a.x + xOfFreq(fr, a.w)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(x, a.y + s(14));
			ctx.lineTo(x, a.y + a.h);
			ctx.stroke();
		}
		ctx.globalAlpha = A;
		ctx.fillStyle = T.text;
		ctx.font = `${s(10)}px ${MONO}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const fr of [100, 1000, 10000]) ctx.fillText(fmtFreqLabel(fr), a.x + xOfFreq(fr, a.w), a.y + s(2));
		ctx.setLineDash([s(3), s(4)]);
		ctx.strokeStyle = T.specSecondary;
		ctx.globalAlpha = A * 0.45;
		ctx.beginPath();
		ctx.moveTo(a.x, yDb(centerDb + rangeDb / 2 - targetOffset));
		ctx.lineTo(a.x + a.w, yDb(centerDb + rangeDb / 2 - targetOffset));
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = A;
		if (f) {
			const g = ctx.createLinearGradient(0, a.y + a.h, 0, a.y);
			for (const st of CMAP) g.addColorStop(st[0], `rgb(${st[1]},${st[2]},${st[3]})`);
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y + a.h);
			for (let i = 0; i < NMEL; i++) ctx.lineTo(a.x + ((i + 0.5) / NMEL) * a.w, yDb(S.specFill[i]));
			ctx.lineTo(a.x + a.w, a.y + a.h);
			ctx.closePath();
			ctx.fill();
			ctx.strokeStyle = "rgba(220,220,220,0.85)";
			ctx.lineWidth = s(1.3);
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			ctx.shadowColor = "rgba(255,150,60,0.55)";
			ctx.shadowBlur = s(5);
			ctx.beginPath();
			for (let i = 0; i < NMEL; i++) {
				const x = a.x + ((i + 0.5) / NMEL) * a.w;
				const y = yDb(S.specLine[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
			ctx.shadowBlur = 0;
			let rf = f[H.PEAK_HZ];
			let rdb = f[H.PEAK_DB] + tiltAt(Math.max(rf, 1), PRESET.spectrum.tilt);
			const m = S.mouse;
			const hover = !!m && m.x >= a.x && m.x < a.x + a.w && m.y >= a.y && m.y < a.y + a.h;
			let showReadout = hover || f[H.PEAK_DB] > -70;
			if (hover && m) {
				rf = freqOfX(m.x - a.x, a.w);
				const bi = clamp(Math.floor(((m.x - a.x) / a.w) * NMEL), 0, NMEL - 1);
				rdb = S.specLine[bi];
				ctx.strokeStyle = T.primary;
				ctx.globalAlpha = A * 0.5;
				ctx.beginPath();
				ctx.moveTo(m.x + 0.5, a.y + s(14));
				ctx.lineTo(m.x + 0.5, a.y + a.h);
				ctx.stroke();
				ctx.globalAlpha = A;
			}
			if (showReadout) {
				const nt = noteOf(rf);
				const txt = `${rdb.toFixed(2)}dB | ${fmtHz(rf)} | ${nt.name} ${nt.cents >= 0 ? "+" : "-"} ${Math.abs(nt.cents)} Cents`;
				ctx.font = `bold ${s(11)}px ${MONO}`;
				const tw = ctx.measureText(txt).width;
				ctx.fillStyle = T.tooltipBg;
				ctx.fillRect(a.x + s(6), a.y + s(14), tw + s(12), s(18));
				ctx.fillStyle = T.tooltipText;
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillText(txt, a.x + s(12), a.y + s(23));
			}
		}
		ctx.restore();
	}

	function drawStereometer(ctx, a, S, f, s) {
		const barW = s(6);
		const barBlock = s(34);
		const pad = s(6);
		const side = Math.max(10, Math.min(a.w - barBlock - pad * 2, a.h - pad * 2));
		const r = side / 2;
		const cx = a.x + pad + (a.w - barBlock - pad * 2) / 2;
		const cy = a.y + a.h / 2;
		ctx.save();
		ctx.beginPath();
		ctx.rect(a.x, a.y, a.w, a.h);
		ctx.clip();
		ctx.strokeStyle = T.stGuides;
		ctx.lineWidth = 1;
		for (const k of [1, 2 / 3, 1 / 3]) {
			ctx.beginPath();
			ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
			ctx.stroke();
		}
		for (const ang of [0, 45, 90, 135]) {
			const t = (ang * Math.PI) / 180;
			ctx.beginPath();
			ctx.moveTo(cx - Math.cos(t) * r, cy - Math.sin(t) * r);
			ctx.lineTo(cx + Math.cos(t) * r, cy + Math.sin(t) * r);
			ctx.stroke();
		}
		ctx.fillStyle = T.secondary;
		ctx.font = `${s(9)}px ${MONO}`;
		ctx.textBaseline = "top";
		ctx.textAlign = "right";
		ctx.fillText("L", cx - r * 0.72, cy - r * 0.72 - s(10));
		ctx.textAlign = "left";
		ctx.fillText("R", cx + r * 0.72, cy - r * 0.72 - s(10));
		const bx = a.x + a.w - pad - barW;
		const by = a.y + pad + s(4);
		const bh = a.h - pad * 2 - s(8);
		ctx.fillStyle = T.bg2;
		ctx.fillRect(bx, by, barW, bh);
		ctx.strokeStyle = T.stGuides;
		ctx.beginPath();
		ctx.moveTo(bx - s(2), by + bh / 2 + 0.5);
		ctx.lineTo(bx + barW + s(2), by + bh / 2 + 0.5);
		ctx.stroke();
		ctx.fillStyle = T.text;
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		ctx.fillText("+1", bx - s(4), by);
		ctx.fillText("0", bx - s(4), by + bh / 2);
		ctx.fillText("-1", bx - s(4), by + bh);
		if (f) {
			const pts = [[0, T.stLow], [1, T.stMid], [2, T.stHigh]];
			let peak = 1e-4;
			for (let b = 0; b < 3; b++) {
				const o = OFF_VEC + b * NVEC * 2;
				for (let i = 0; i < NVEC; i++) {
					const L = f[o + i * 2];
					const R = f[o + i * 2 + 1];
					peak = Math.max(peak, Math.abs(L - R) * 0.7071, Math.abs(L + R) * 0.7071);
				}
			}
			const target = clamp(0.92 / peak, 1, 200);
			S.stereo.gain += (target - S.stereo.gain) * (target < S.stereo.gain ? 0.5 : 0.08);
			const g = S.stereo.gain * r;
			const ps = Math.max(1, s(PRESET.stereometer.pointSize * 0.6));
			for (const [b, color] of pts) {
				ctx.fillStyle = color;
				const o = OFF_VEC + b * NVEC * 2;
				for (let i = 0; i < NVEC; i++) {
					const L = f[o + i * 2];
					const R = f[o + i * 2 + 1];
					const x = cx + (L - R) * 0.7071 * g;
					const y = cy - (L + R) * 0.7071 * g;
					ctx.fillRect(x - ps / 2, y - ps / 2, ps, ps);
				}
			}
			const yc2 = c => by + ((1 - clamp(c, -1, 1)) / 2) * bh;
			const marks = [[f[H.CORR_LOW], T.stLow], [f[H.CORR_MID], T.stMid], [f[H.CORR_HIGH], T.stHigh]];
			for (const [c, color] of marks) {
				ctx.fillStyle = color;
				ctx.fillRect(bx - s(1), yc2(c) - s(1.5), barW + s(2), s(3));
			}
			ctx.fillStyle = T.stPrimary;
			ctx.fillRect(bx - s(2), yc2(f[H.CORR]) - 0.5, barW + s(4), 1);
		}
		ctx.restore();
	}

	function drawLoudness(ctx, a, S, f, s) {
		const pad = s(9);
		const cx = a.x + a.w / 2;
		const st = f ? f[H.LUFS_S] : -120;
		const fmt = (v, d = 1) => (v <= SILENCE_LUFS ? "-inf" : v.toFixed(d));
		ctx.save();
		ctx.beginPath();
		ctx.rect(a.x, a.y, a.w, a.h);
		ctx.clip();
		const numFont = clamp(a.w * 0.2, s(20), s(38));
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		ctx.fillStyle = T.primary;
		ctx.font = `600 ${numFont}px ${MONO}`;
		ctx.fillText(fmt(st), cx, a.y + pad + numFont * 0.82);
		ctx.fillStyle = T.secondary;
		ctx.font = `${s(9)}px ${MONO}`;
		ctx.fillText("LUFS  short-term", cx, a.y + pad + numFont + s(9));
		const headerH = pad + numFont + s(18);
		const footerH = s(58);
		const my0 = a.y + headerH;
		const my1 = a.y + a.h - footerH;
		const mh = Math.max(s(20), my1 - my0);
		const { scaleLu: scale, expandLu, expandFrac } = PRESET.loudness;
		const yLu = v => {
			const lu = clamp(-v, 0, scale);
			const t = lu <= expandLu
				? (lu / expandLu) * expandFrac
				: expandFrac + ((lu - expandLu) / (scale - expandLu)) * (1 - expandFrac);
			return my0 + t * mh;
		};
		ctx.fillStyle = T.text;
		ctx.font = `${s(9)}px ${MONO}`;
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		const labelX = a.x + pad + s(12);
		for (const tk of PRESET.loudness.ticks) ctx.fillText(String(tk), labelX, yLu(-tk));
		const bx0 = labelX + s(6);
		const bAvail = a.x + a.w - pad - bx0;
		const thin = clamp(bAvail * 0.16, s(6), s(13));
		const wide = clamp(bAvail * 0.3, s(11), s(22));
		const gap = s(5);
		const groupW = thin * 2 + gap * 2 + wide;
		const bx = bx0 + Math.max(0, (bAvail - groupW) / 2);
		const xL = bx;
		const xR = bx + thin + gap;
		const xS = bx + thin * 2 + gap * 2;
		ctx.fillStyle = T.bg2;
		ctx.fillRect(xL, my0, thin, mh);
		ctx.fillRect(xR, my0, thin, mh);
		ctx.fillRect(xS, my0, wide, mh);
		ctx.strokeStyle = T.secondary;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(xS, yLu(-14) + 0.5);
		ctx.lineTo(xS + wide, yLu(-14) + 0.5);
		ctx.stroke();
		if (f) {
			const bar = (x, w, v, hot) => {
				const y = yLu(v);
				ctx.fillStyle = hot ? T.error : T.loudPrimary;
				ctx.fillRect(x, y, w, my0 + mh - y);
			};
			bar(xL, thin, f[H.TP_L], f[H.TP_L] > -0.3);
			bar(xR, thin, f[H.TP_R], f[H.TP_R] > -0.3);
			bar(xS, wide, st, false);
			ctx.fillStyle = T.primary;
			ctx.fillRect(xL, yLu(S.loud.holdL) - 0.5, thin, 1);
			ctx.fillRect(xR, yLu(S.loud.holdR) - 0.5, thin, 1);
			ctx.fillStyle = T.secondary;
			ctx.font = `${s(8)}px ${MONO}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			ctx.fillText("L", xL + thin / 2, my1 + s(2));
			ctx.fillText("R", xR + thin / 2, my1 + s(2));
			ctx.fillText("S", xS + wide / 2, my1 + s(2));
			const tpMax = Math.max(f[H.TP_L], f[H.TP_R]);
			const plr = f[H.LUFS_I] > SILENCE_LUFS && tpMax > SILENCE_LUFS ? (tpMax - f[H.LUFS_I]).toFixed(1) : "--";
			ctx.fillStyle = T.text;
			ctx.font = `${s(9.5)}px ${MONO}`;
			ctx.textAlign = "left";
			ctx.textBaseline = "alphabetic";
			const ly = my1 + s(16);
			ctx.fillText(`M ${fmt(f[H.LUFS_M])}   I ${fmt(f[H.LUFS_I])}`, a.x + pad, ly);
			ctx.fillText(`LRA ${f[H.LRA].toFixed(1)}   TP ${fmt(tpMax)}`, a.x + pad, ly + s(13));
			ctx.fillText(`PLR ${plr}   corr ${f[H.CORR].toFixed(2)}`, a.x + pad, ly + s(26));
		}
		ctx.restore();
	}

	// ---- layout ----
	function sliceCols(x, y, w, h, weights, g) {
		const tot = weights.reduce((p, c) => p + c, 0);
		const avail = w - g * (weights.length - 1);
		const out = [];
		let cx = x;
		weights.forEach((wt, i) => {
			const cw = i === weights.length - 1 ? x + w - cx : Math.round((avail * wt) / tot);
			out.push({ x: cx, y, w: cw, h });
			cx += cw + g;
		});
		return out;
	}
	function layout(W, Hh, g) {
		const aspect = W / Hh;
		if (aspect > 2.4) {
			const r = sliceCols(0, 0, W, Hh, [3, 3, 2, 1.3, 1.7, 1.6], g);
			return { spectrogram: r[0], spectrum: r[1], waveform: r[2], oscilloscope: r[3], stereometer: r[4], loudness: r[5] };
		}
		const RW = Math.round(W * (aspect < 1.05 ? 0.3 : 0.26));
		const railX = W - RW;
		const MW = railX - g;
		const sq = Math.min(RW, Math.round(Hh * 0.44));
		const loudness = { x: railX, y: 0, w: RW, h: Hh - sq - g };
		const stereometer = { x: railX, y: Hh - sq, w: RW, h: sq };
		const h1 = Math.round(Hh * 0.36);
		const h2 = Math.round(Hh * 0.4);
		const h3 = Hh - h1 - h2 - g * 2;
		const spectrogram = { x: 0, y: 0, w: MW, h: h1 };
		const spectrum = { x: 0, y: h1 + g, w: MW, h: h2 };
		const strip = sliceCols(0, h1 + h2 + g * 2, MW, h3, [1.7, 1], g);
		return { spectrogram, spectrum, waveform: strip[0], oscilloscope: strip[1], stereometer, loudness };
	}

	// ---- draw one frame (was the React onRender) ----
	function render(ctx, S) {
		if (!ctx || S.isError) return;
		try {
			const now = performance.now();
			if (now < S.nextRenderT) return;
			S.nextRenderT = Math.max(now, S.nextRenderT + 1000 / 144);
			const W = ctx.canvas.width;
			const Hh = ctx.canvas.height;
			const dpr = window.devicePixelRatio || 1;
			const s = px => px * dpr;
			ctx.fillStyle = T.bg;
			ctx.fillRect(0, 0, W, Hh);

			const link = S.link;
			const live = !!(link && link.live);
			const f = live ? link.frame : null;
			const fresh = !!f && link.seq !== S.seq;
			const nNew = f && link ? Math.max(0, link.seq - S.spectroSeq) : 0;
			if (link) S.spectroSeq = link.seq;
			if (f && fresh) { S.seq = link.seq; ingest(S, f, now); }

			const sep = Math.max(2, Math.round(s(3)));
			const L = layout(W, Hh, sep);
			const all = [L.spectrogram, L.spectrum, L.waveform, L.oscilloscope, L.stereometer, L.loudness];
			const silent = !!f && f[H.LUFS_M] < SILENCE_LUFS;
			if (silent) { if (S.silentSince < 0) S.silentSince = now; }
			else S.silentSince = -1;
			const targetAlpha = silent && now - S.silentSince > 1000 ? 0.4 : 1;
			S.alpha += (targetAlpha - S.alpha) * 0.08;
			ctx.globalAlpha = S.alpha;
			drawSpectrogram(ctx, L.spectrogram, S, f, nNew);
			drawSpectrum(ctx, L.spectrum, S, f, s);
			drawWaveform(ctx, L.waveform, S, s);
			drawOscilloscope(ctx, L.oscilloscope, S, f, s);
			drawStereometer(ctx, L.stereometer, S, f, s);
			drawLoudness(ctx, L.loudness, S, f, s);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = T.bg2;
			ctx.lineWidth = 1;
			for (const a of all) ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(a.w) - 1, Math.round(a.h) - 1);

			if (!live) {
				ctx.fillStyle = T.tooltipBg;
				ctx.fillRect(0, Hh / 2 - s(16), W, s(32));
				ctx.fillStyle = T.text;
				ctx.font = `${s(11)}px ${MONO}`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(`bridge offline (${BRIDGE_URL}) - start minimeters-bridge`, W / 2, Hh / 2);
			}
		} catch (e) {
			// no dejar que un error puntual de dibujo tumbe el loop
		}
	}

	// ---- overlay + ciclo de vida ----
	let overlay = null, canvas = null, ctx = null, S = null, raf = 0;

	function fit() {
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
	}

	function loop() {
		if (!overlay) return;
		fit();
		render(ctx, S);
		raf = requestAnimationFrame(loop);
	}

	function open() {
		if (overlay) return;
		overlay = document.createElement("div");
		overlay.id = "realmeters-overlay";
		overlay.style.cssText =
			"position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;";
		const bar = document.createElement("div");
		bar.style.cssText =
			"flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;" +
			"padding:6px 12px;color:#a4a4a4;font:12px " + MONO + ";background:#000;";
		bar.innerHTML = "<span>RealMeters &mdash; real-output metering</span>";
		const closeBtn = document.createElement("button");
		closeBtn.textContent = "✕ Close (Esc)";
		closeBtn.style.cssText =
			"background:rgb(48,48,48);color:#c0c0c0;border:0;border-radius:4px;padding:4px 10px;" +
			"cursor:pointer;font:12px " + MONO + ";";
		closeBtn.onclick = close;
		bar.appendChild(closeBtn);
		canvas = document.createElement("canvas");
		canvas.style.cssText = "flex:1 1 auto;width:100%;height:100%;display:block;background:#000;";
		overlay.appendChild(bar);
		overlay.appendChild(canvas);
		document.body.appendChild(overlay);

		ctx = canvas.getContext("2d");
		S = makeState();
		S.canvas = canvas;
		if (!ctx) { S.isError = true; return; }
		S.link = new MeterLink(window);
		S.onMove = e => {
			const dpr = window.devicePixelRatio || 1;
			S.mouse = { x: e.offsetX * dpr, y: e.offsetY * dpr };
		};
		S.onLeave = () => { S.mouse = null; };
		canvas.addEventListener("mousemove", S.onMove);
		canvas.addEventListener("mouseleave", S.onLeave);
		document.addEventListener("keydown", onKey);
		fit();
		raf = requestAnimationFrame(loop);
	}

	function close() {
		if (!overlay) return;
		cancelAnimationFrame(raf);
		raf = 0;
		document.removeEventListener("keydown", onKey);
		if (S) {
			if (S.link) S.link.close();
			if (canvas && S.onMove) canvas.removeEventListener("mousemove", S.onMove);
			if (canvas && S.onLeave) canvas.removeEventListener("mouseleave", S.onLeave);
		}
		overlay.remove();
		overlay = null; canvas = null; ctx = null; S = null;
	}

	function onKey(e) { if (e.key === "Escape") close(); }
	function toggle() { overlay ? close() : open(); }

	// ---- botón + integración con Spotify ----
	const ICON =
		"<svg role='img' height='16' width='16' viewBox='0 0 16 16' fill='currentColor'>" +
		"<rect x='1' y='6' width='2' height='4'/><rect x='5' y='3' width='2' height='10'/>" +
		"<rect x='9' y='1' width='2' height='14'/><rect x='13' y='5' width='2' height='6'/></svg>";
	if (S_API.Playbar && S_API.Playbar.Button) {
		new S_API.Playbar.Button("RealMeters", ICON, toggle, false, false);
	} else {
		new S_API.Topbar.Button("RealMeters", ICON, toggle);
	}
	// cambio de pista -> reiniciar el LUFS integrado del bridge
	S_API.Player.addEventListener("songchange", () => { if (S && S.link) S.link.send("reset"); });
})();
