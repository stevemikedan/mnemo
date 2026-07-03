/**
 * Canonicalize a scope/path: backslashes → forward slashes so that a Windows
 * cwd ('C:\\proj') and a stored scope ('project:C:/proj') compare equal.
 * Applied on write (in the store) and on read (query/visibility).
 */
export function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/');
}

/**
 * Resolve the effective scope string for a given project path.
 * - Returns 'global' if no path given
 * - Returns 'project:{abs_path}' if a path is given
 */
export function resolveScope(projectPath?: string): string {
  if (!projectPath) return 'global';
  return `project:${normalizeScope(projectPath)}`;
}

/**
 * Check if a memory's scope is visible from the given CWD (slash-insensitive).
 */
export function isScopeVisible(memoryScope: string, cwd: string): boolean {
  if (memoryScope === 'global') return true;
  if (memoryScope.startsWith('project:')) {
    const scopePath = normalizeScope(memoryScope.slice(8));
    const c = normalizeScope(cwd);
    // Exact match, or cwd is nested under scopePath. Require a path-separator
    // boundary so 'project:/foo' does not leak into a sibling like '/foobar'.
    return c === scopePath || c.startsWith(scopePath + '/');
  }
  if (memoryScope.startsWith('session:')) {
    // Session memories only visible if explicitly queried
    return false;
  }
  return false;
}
