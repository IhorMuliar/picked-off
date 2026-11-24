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
      // styled by `.chain-status` in the app stylesheet (position, colours per data-kind)
      this.el.className = "chain-status";
      document.body.appendChild(this.el);
    }
    this.el.textContent = b.text;
    this.el.dataset.kind = b.kind;
    this.el.style.display = "";
  }
  remove() {
    this.el?.remove();
    this.el = null;
    this.last = "";
  }
}
