export function createLogger(service) {
  const emit = (level, msg, extra) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...extra }));
  return {
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}
