import { useRef, type ComponentProps } from 'react';
import { Link, type LinkProps } from 'react-router';
import { useLens } from '../../design/glass/useLens';
import { buttonClasses, isGlassVariant, type ButtonStyleProps } from './button-styles';
import { Spinner } from './Spinner';

export function Button({
  variant,
  size,
  icon,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonStyleProps & ComponentProps<'button'>) {
  const ref = useRef<HTMLButtonElement>(null);
  useLens(ref, isGlassVariant(variant) ? {} : false);
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClasses({ variant, size }, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  icon,
  className,
  children,
  ...props
}: ButtonStyleProps & LinkProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  useLens(ref, isGlassVariant(variant) ? {} : false);
  return (
    <Link ref={ref} className={buttonClasses({ variant, size }, className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}
