/**
 * Resolve the effective scope string for a given project path.
 * - Returns 'global' if no path given
 * - Returns 'project:{abs_path}' if a path is given
 */
export function resolveScope(projectPath?: string): string {
  if (!projectPath) return 'global';
  return `project:${projectPath}`;
}

/**
 * Check if a memory's scope is visible from the given CWD.
 */
export function isScopeVisible(memoryScope: string, cwd: string): boolean {
  if (memoryScope === 'global') return true;
  if (memoryScope.startsWith('project:')) {
    const scopePath = memoryScope.slice(8);
    // Exact match, or cwd is nested under scopePath. Require a path separator
    // boundary so 'project:/foo' does not leak into a sibling like '/foobar'.
    return cwd === scopePath
      || cwd.startsWith(scopePath + '/')
      || cwd.startsWith(scopePath + '\\');
  }
  if (memoryScope.startsWith('session:')) {
    // Session memories only visible if explicitly queried
    return false;
  }
  return false;
}
