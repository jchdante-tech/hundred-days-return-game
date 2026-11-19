import './brand-logo.css';

type BrandLogoProps = {
  className?: string;
  decorative?: boolean;
};

export default function BrandLogo({ className = '', decorative = false }: BrandLogoProps) {
  return (
    <img
      className={`brand-logo ${className}`.trim()}
      src="/art/brand-wordmark-v18.png"
      width={512}
      height={192}
      alt={decorative ? '' : '百日回归'}
      aria-hidden={decorative || undefined}
      draggable={false}
    />
  );
}
