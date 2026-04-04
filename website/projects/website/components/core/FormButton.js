import { cn } from '@/lib/utils';

export default function FormButton({ primary, className, ...restProps }) {
  return (
    <button
      className={cn(
        'flex justify-center items-center w-full px-3 py-2 rounded-md font-medium text-lg',
        primary && 'bg-gradient-to-r from-orange-500 to-pink-500 bg-gradient-animate text-white hover:from-orange-600 hover:to-pink-600 disabled:bg-none disabled:bg-gray-400 disabled:text-gray-200',
        !primary && 'bg-white/15 text-white/75 hover:bg-white/20 hover:text-white/80 disabled:bg-white/10 disabled:text-white/35',
        className,
      )}
      {...restProps}
    />
  );
}
