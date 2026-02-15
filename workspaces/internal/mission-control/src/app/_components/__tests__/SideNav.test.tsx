import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SideNav } from '../SideNav';

vi.mock('next/link', () => {
  return {
    default: (
      { href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
    ) => (
      <a href={href} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock('next/navigation', () => {
  return {
    usePathname: () => '/',
  };
});

describe('SideNav', () => {
  it('renders primary navigation links', () => {
    render(<SideNav />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Goals' })).toHaveAttribute('href', '/goals');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
  });
});
