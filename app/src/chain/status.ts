/**
 * Connection banner for the chain driver: a small fixed element outside the React tree,
 * shown while connecting, offline, waiting for a round or short of devnet SOL.
 */
export type Banner = { kind: "connecting" | "offline" | "waiting" | "info"; text: string } | null;

export class StatusBanner {
  private el: HTMLDivElement | null = null;
  private last = "";
  show(b: Banner) {
    if (typeof document === "undefined") return;
    const key = b ? `${b.kind}:${b.text}` : "";
    if (key === this.last) return;
    this.last = key;
    if (!b) {
      if (this.el) this.el.style.display = "none";
      return;
    }
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.setAttribute("role", "status");
      this.el.setAttribute("aria-live", "polite");
      this.el.dataset.testid = "chain-status";
      Object.assign(this.el.style, {
        position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: "1000",
        padding: "8px 14px", borderRadius: "8px", font: "500 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: "calc(100vw - 32px)", boxSizing: "border-box", textAlign: "center", pointerEvents: "none",
        boxShadow: "0 4px 18px rgba(0,0,0,.35)",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(this.el);
    }
    const colors = { connecting: ["#1d2a3a", "#9cc7ff"], offline: ["#3a1d1d", "#ffb0a8"], waiting: ["#1f2a24", "#a8e6c0"], info: ["#2a2617", "#f3d98b"] }[b.kind];
    this.el.style.background = colors[0];
    this.el.style.color = colors[1];
    this.el.style.border = `1px solid ${colors[1]}55`;
    const dot = b.kind === "offline" ? "● " : b.kind === "connecting" ? "◌ " : "";
    this.el.textContent = dot + b.text;
    this.el.dataset.kind = b.kind;
    this.el.style.display = "block";
  }
  remove() {
    this.el?.remove();
    this.el = null;
    this.last = "";
  }
}
