import dependency = require('./dependency.js');

function helper(): number {
  return dependency;
}

export = { rebuilt: helper };
