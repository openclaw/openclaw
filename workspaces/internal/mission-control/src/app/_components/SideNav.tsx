import { NavLink } from './NavLink';

export function SideNav() {
  return (
    <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-slate-800 bg-slate-950/60">
      <div className="px-4 py-4">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Mission Control</div>
        <div className="mt-4 space-y-1">
          <NavLink href="/" label="Dashboard" />
          <NavLink href="/goals" label="Goals" />
          <NavLink href="/calendar" label="Calendar" />
        </div>
      </div>
    </aside>
  );
}
