import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NavLink } from '../NavLink';

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

const mockUsePathname = vi.fn<string, []>();
vi.mock('next/navigation', () => {
  return {
    usePathname: () => mockUsePathname(),
  };
});

describe('NavLink', () => {
  it('marks the link as active when pathname matches href', () => {
    mockUsePathname.mockReturnValue('/goals');

    render(<NavLink href="/goals" label="Goals" />);

    const link = screen.getByRole('link', { name: 'Goals' });
    expect(link).toHaveAttribute('href', '/goals');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not set aria-current when inactive', () => {
    mockUsePathname.mockReturnValue('/');

    render(<NavLink href="/goals" label="Goals" />);

    const link = screen.getByRole('link', { name: 'Goals' });
    expect(link).not.toHaveAttribute('aria-current');
  });
});
