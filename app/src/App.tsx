export function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        display: "grid",
        placeContent: "center",
        gap: "0.75rem",
        padding: "1.5rem",
        textAlign: "center",
        background: "#070A12",
        color: "#E6ECF5",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }}
    >
      <h1 style={{ margin: 0, color: "#2EF2D0", letterSpacing: "0.08em" }}>Picked Off</h1>
      <p style={{ margin: 0, maxWidth: "36rem" }}>
        Hide your order in a dark book. Ping for everyone else's. Pick them off before the closing bell.
      </p>
      <p style={{ margin: 0, opacity: 0.6 }}>In development - Solana Blitz v10</p>
    </main>
  );
}
