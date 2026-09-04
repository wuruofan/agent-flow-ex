type Shutdown = () => void;

function defaultShutdown(): void {
  // Short grace so this tool's response flushes to the client before the
  // process dies. The server is stateless (state in tasks.db) and in-flight
  // workers are detached into their own process group, so exiting is safe and
  // does not disturb running tasks. The host respawns a fresh server (loading
  // the current dist) on stdin/stdout close.
  setTimeout(() => process.exit(0), 300);
}

/**
 * Triggers a restart of the *calling* MCP server connection. Only this
 * connection's process exits; other live servers and any in-flight workers are
 * unaffected. `shutdown` is injectable for tests (defaults to process.exit).
 */
export function restart(shutdown: Shutdown = defaultShutdown): { restarting: true; note: string } {
  shutdown();
  return { restarting: true, note: "server exiting; host will respawn with current dist" };
}
