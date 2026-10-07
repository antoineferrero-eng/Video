import type { ComponentProps } from 'react';
import { Link, type LinkProps } from 'react-router';
import { buttonClasses, type ButtonStyleProps } from './button-styles';
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
  return (
    <button
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
  return (
    <Link className={buttonClasses({ variant, size }, className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}
