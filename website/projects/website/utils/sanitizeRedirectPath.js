export default function sanitizeRedirectPath(path) {
  if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) {
    return path;
  }
  return null;
}
