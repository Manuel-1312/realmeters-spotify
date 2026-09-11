import React, { useEffect, useState } from "react";
import styles from "./app.module.scss";
import MiniMetersVisualizer from "./MiniMetersVisualizer";

// App de Spicetify: una sola vista a pantalla completa con el visualizer MiniMeters.
// El análisis (LUFS, espectro, true-peak, etc.) llega del bridge local por WebSocket;
// aquí sólo se dibuja. Al cambiar de pista se incrementa songToken para que el
// renderer pida al bridge reiniciar el LUFS integrado.
export default function App() {
	const [songToken, setSongToken] = useState(0);

	useEffect(() => {
		const onSong = () => setSongToken(t => t + 1);
		Spicetify.Player.addEventListener("songchange", onSong as PlayerEventListener);
		return () => Spicetify.Player.removeEventListener("songchange", onSong as PlayerEventListener);
	}, []);

	return (
		<div className={styles.container}>
			<MiniMetersVisualizer isEnabled={true} songToken={songToken} />
		</div>
	);
}
