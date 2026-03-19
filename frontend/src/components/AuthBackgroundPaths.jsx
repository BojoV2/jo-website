import { useMemo } from 'react';
import { motion } from 'framer-motion';

function buildPaths(position) {
  return Array.from({ length: 30 }, (_, i) => ({
    id: `${position}-${i}`,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${
      380 - i * 5 * position
    } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${
      152 - i * 5 * position
    } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${
      684 - i * 5 * position
    } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.8 + i * 0.045,
    opacity: 0.05 + i * 0.015,
    duration: 22 + i * 0.45
  }));
}

function FloatingPathSet({ position, theme }) {
  const paths = useMemo(() => buildPaths(position), [position]);
  const stroke = theme === 'dark' ? '#dbeafe' : '#0f172a';

  return (
    <svg
      className={position > 0 ? 'auth-paths-svg auth-paths-svg-left' : 'auth-paths-svg auth-paths-svg-right'}
      viewBox="0 0 696 316"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths.map((path) => (
        <motion.path
          key={path.id}
          d={path.d}
          stroke={stroke}
          strokeWidth={path.width}
          strokeOpacity={path.opacity}
          initial={{ pathLength: 0.25, opacity: path.opacity * 0.75 }}
          animate={{
            pathLength: 1,
            opacity: [path.opacity * 0.45, path.opacity, path.opacity * 0.45],
            pathOffset: [0, 1, 0]
          }}
          transition={{
            duration: path.duration,
            repeat: Number.POSITIVE_INFINITY,
            ease: 'linear'
          }}
        />
      ))}
    </svg>
  );
}

export default function AuthBackgroundPaths({ theme = 'light' }) {
  return (
    <div className={theme === 'dark' ? 'auth-paths-layer is-dark' : 'auth-paths-layer is-light'} aria-hidden="true">
      <FloatingPathSet position={1} theme={theme} />
      <FloatingPathSet position={-1} theme={theme} />
    </div>
  );
}
