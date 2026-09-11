import React, { useRef, useEffect, useState, useCallback } from "react";

// Canvas 2D con bucle de dibujo (requestAnimationFrame) y ajuste de resolución al
// tamaño real (devicePixelRatio + ResizeObserver). Genérico y autónomo.
//   onInit   -> crea el estado del dibujo una vez (recibe el contexto 2D)
//   onResize -> se llama tras cada cambio de tamaño
//   onRender -> se llama cada frame mientras isEnabled sea true
export default function AnimatedCanvas<S>(props: {
	onInit: (ctx: CanvasRenderingContext2D | null) => S;
	onResize?: (ctx: CanvasRenderingContext2D | null, state: S) => void;
	onRender: (ctx: CanvasRenderingContext2D | null, data: unknown, state: S) => void;
	data: unknown;
	isEnabled: boolean;
	style?: React.CSSProperties;
}) {
	const { onInit, onResize, onRender, data, isEnabled, style } = props;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [state, setState] = useState<S | null>(null);

	const fit = useCallback((canvas: HTMLCanvasElement, win: Window) => {
		const w = Math.round(canvas.clientWidth * win.devicePixelRatio);
		const h = Math.round(canvas.clientHeight * win.devicePixelRatio);
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
	}, []);

	// init
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const win = canvas.ownerDocument.defaultView;
		if (!win) return;
		const ctx = canvas.getContext("2d");
		const s = onInit(ctx);
		fit(canvas, win);
		onResize?.(ctx, s);
		setState(s);
		return () => setState(null);
	}, [onInit]);

	// bucle de render
	useEffect(() => {
		if (!isEnabled || state === null) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const win = canvas.ownerDocument.defaultView;
		if (!win) return;
		const ctx = canvas.getContext("2d");
		let raf = 0;
		const loop = () => {
			onRender(ctx, data, state);
			raf = win.requestAnimationFrame(loop);
		};
		raf = win.requestAnimationFrame(loop);
		return () => win.cancelAnimationFrame(raf);
	}, [onRender, data, state, isEnabled]);

	// resize
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const win = canvas.ownerDocument.defaultView;
		if (!win) return;
		const ro = new win.ResizeObserver(() => {
			const c = canvasRef.current;
			const w = c?.ownerDocument.defaultView;
			if (!c || !w) return;
			fit(c, w);
			if (state !== null) onResize?.(c.getContext("2d"), state);
		});
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [onResize, state]);

	return (
		<canvas
			ref={canvasRef}
			style={{ width: "100%", height: "100%", ...style, ...(isEnabled ? {} : { visibility: "hidden" }) }}
		/>
	);
}
