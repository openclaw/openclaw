'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function cls(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;

  return (
    <Link
      href={href}
      className={cls(
        'block rounded-md px-3 py-2 text-sm',
        active
          ? 'bg-slate-800 text-slate-50'
          : 'text-slate-300 hover:bg-slate-900 hover:text-slate-50'
      )}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}
