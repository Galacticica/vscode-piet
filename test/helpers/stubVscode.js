// Installs a minimal 'vscode' module stub so host code (runner.ts) can be
// required under plain Node. Require this before requiring any built bundle.
const Module = require("module");

class EventEmitter {
  constructor() {
    this.handlers = [];
    this.event = (handler) => {
      this.handlers.push(handler);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const handler of this.handlers) {
      handler(value);
    }
  }
}

const stub = { EventEmitter };

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return stub;
  }
  return originalLoad.call(this, request, ...rest);
};

module.exports = stub;
