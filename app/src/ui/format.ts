export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const odds = (total: number, onDesk: number) => (onDesk > 0 ? `${(total / onDesk).toFixed(1)}×` : "—");
export const DESK_COLORS = ["#8FA8FF", "#B48CFF", "#6FD3FF", "#F28FD0", "#9BE38A", "#FF9F6B", "#7FE0C8", "#D6C26A"];
