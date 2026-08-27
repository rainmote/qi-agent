export function BrandMark({ size = 24 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.4 16.9c2.5 2.9 6.4 4.1 10 2.7 3.6-1.4 5.8-5 5.3-8.8-1.8 2.1-4.9 2.5-7.2.9-1.6-1.1-2.4-3-2.2-4.9-3.6.6-6.3 3.7-6.3 7.4 0 1 .1 1.9.4 2.7Z" fill="currentColor" opacity=".95" />
    <path d="M4.6 16.5c2.5-2.1 5.8-2.7 8.8-1.5 1.3.5 2.4 1.3 3.3 2.3M10.5 6.9c-.2-1.6.4-3.1 1.6-4.1.2 2 1.6 3.7 3.5 4.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="14.7" cy="10" r=".8" fill="currentColor" />
  </svg>;
}
