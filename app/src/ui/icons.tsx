/** Small line icons drawn in SVG (no image assets). 16 px grid, currentColor. */
type P = { size?: number; className?: string };
const svg = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    {children}
  </svg>
);

export const BellIcon = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" /><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" /></>);
export const SoundIcon = ({ size = 16, className, off }: P & { off?: boolean }) =>
  svg(size, className, <><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" />{off ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <><path d="M11 5.5a3.5 3.5 0 0 1 0 5" /><path d="M12.8 3.6a6 6 0 0 1 0 8.8" /></>}</>);
export const Chevron = ({ size = 12, className }: P) => svg(size, className, <path d="M6 3.5L10.5 8 6 12.5" />);
export const CloseIcon = ({ size = 16, className }: P) => svg(size, className, <path d="M4 4l8 8M12 4l-8 8" />);
export const CheckIcon = ({ size = 14, className }: P) => svg(size, className, <path d="M3 8.5l3.2 3L13 4.5" />);
export const CrossIcon = ({ size = 12, className }: P) => svg(size, className, <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
export const MoveIcon = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M8 2v12M8 2L5.5 4.5M8 2l2.5 2.5M8 14l-2.5-2.5M8 14l2.5-2.5" /></>);
export const ShieldIcon = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z" /><path d="M5.8 8l1.6 1.6L10.4 6.4" /></>);
export const TapeIcon = ({ size = 14, className }: P) =>
  svg(size, className, <><rect x="2" y="4" width="12" height="8" rx="2" /><circle cx="5.5" cy="8" r="1.4" /><circle cx="10.5" cy="8" r="1.4" /></>);
export const ExternalIcon = ({ size = 12, className }: P) => svg(size, className, <><path d="M6.5 3.5H3.5v9h9v-3" /><path d="M9 3h4v4M13 3L7.5 8.5" /></>);
