'use strict';

function ts() {
  return new Date().toISOString();
}

function format(level, msg, meta) {
  const base = `[${ts()}] ${level.toUpperCase()} ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    try {
      return `${base} ${JSON.stringify(meta)}`;
    } catch {
      return base;
    }
  }
  return base;
}

module.exports = {
  info: (msg, meta) => console.log(format('info', msg, meta)),
  warn: (msg, meta) => console.warn(format('warn', msg, meta)),
  error: (msg, meta) => console.error(format('error', msg, meta)),
  debug: (msg, meta) => {
    if (process.env.DEBUG) console.log(format('debug', msg, meta));
  },
};
